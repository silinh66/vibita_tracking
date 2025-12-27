import { useState, useCallback, useEffect } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  DropZone,
  Banner,
  Thumbnail,
  List,
  InlineStack,
  Spinner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { NoteIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { json, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  if (url.searchParams.get("action") === "download_sample") {
    // Fetch real open orders to make the sample useful
    const response = await admin.graphql(
      `#graphql
      query {
        orders(first: 3, query: "fulfillment_status:unfulfilled") {
          edges {
            node {
              name
              legacyResourceId
            }
          }
        }
      }`
    );
    const responseJson = await response.json();
    const orders = responseJson.data.orders.edges.map(e => e.node);

    let csvContent = "Order Name,Tracking Number,Tracking Company\n";

    if (orders.length > 0) {
      orders.forEach((order, index) => {
        csvContent += `${order.name},VIBITA-TEST-${1000 + index},FedEx\n`;
      });
    } else {
      // Fallback if no orders
      csvContent += "#1001,TEST-TRACK-1,DHL\n#1002,TEST-TRACK-2,FedEx\n#1003,TEST-TRACK-3,UPS\n";
    }

    return json({ csvContent });
  }

  return null;
};




export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    const uploadHandler = unstable_createMemoryUploadHandler({
      maxPartSize: 50 * 1024 * 1024, // 50MB
    });
    const formData = await unstable_parseMultipartFormData(request, uploadHandler);
    const file = formData.get("file");

    if (!file || typeof file === "string") {
      return json({ status: "error", message: "No file uploaded. Please select a valid CSV, Excel, or TXT file." });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    let records = [];
    const filename = file.name.toLowerCase();

    // Parse File
    try {
      if (filename.endsWith(".csv") || filename.endsWith(".txt")) {
        const content = buffer.toString("utf-8");
        records = parse(content, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_column_count: true,
          bom: true
        });
      } else if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        records = XLSX.utils.sheet_to_json(sheet);
      } else {
        return json({ status: "error", message: "Unsupported file type. Please upload .csv, .xlsx, .xls, or .txt" });
      }
    } catch (e) {
      return json({ status: "error", message: "Error parsing file: " + e.message });
    }

    if (records.length === 0) {
      return json({ status: "error", message: "No records found in the uploaded file." });
    }

    // Process Records
    const results = { success: 0, fail: 0, errors: [] };

    // Identify columns
    const firstRow = records[0];
    const keys = Object.keys(firstRow).map(k => k.toLowerCase());

    const orderKeyOriginal = Object.keys(firstRow).find(k => {
      const lower = k.toLowerCase();
      return lower.includes("order") || lower.includes("name") || lower === "id";
    });

    const trackingKeyOriginal = Object.keys(firstRow).find(k => {
      const lower = k.toLowerCase();
      return lower.includes("tracking") && !lower.includes("company") && !lower.includes("url");
    });

    const companyKeyOriginal = Object.keys(firstRow).find(k => {
      const lower = k.toLowerCase();
      return lower.includes("company") || lower.includes("carrier");
    });

    if (!orderKeyOriginal || !trackingKeyOriginal) {
      return json({
        status: "error",
        message: `Could not identify 'Order' and 'Tracking Number' columns. Found columns: ${Object.keys(firstRow).join(", ")}`
      });
    }

    for (const row of records) {
      const orderIdentifier = row[orderKeyOriginal];
      const trackingNumber = row[trackingKeyOriginal];
      const trackingCompany = companyKeyOriginal ? row[companyKeyOriginal] : null;

      if (!orderIdentifier || !trackingNumber) {
        results.fail++;
        continue;
      }

      try {
        // 1. Find Order
        // Search by Name (e.g. #1001) or ID
        const query = `name:${orderIdentifier} OR id:${orderIdentifier}`; // Simple query
        const searchResponse = await admin.graphql(
          `query getOrder($query: String!) {
              orders(first: 1, query: $query) {
                edges {
                  node {
                    id
                    name
                    fulfillmentOrders(first: 5) {
                        edges {
                            node {
                                id
                                status
                            }
                        }
                    }
                  }
                }
              }
            }`,
          { variables: { query: orderIdentifier.toString() } } // Querying directly with identifier usually looks for name or other fields
        );

        const searchJson = await searchResponse.json();
        const edges = searchJson.data?.orders?.edges;

        if (!edges || edges.length === 0) {
          results.fail++;
          results.errors.push(`Order not found: ${orderIdentifier}`);
          continue;
        }

        const orderNode = edges[0].node;
        const fulfillmentOrders = orderNode.fulfillmentOrders.edges;

        // Find open fulfillment order
        const openFulfillmentOrder = fulfillmentOrders.find(e => e.node.status === 'OPEN' || e.node.status === 'IN_PROGRESS');

        if (!openFulfillmentOrder) {
          results.fail++;
          results.errors.push(`No open fulfillment order for: ${orderIdentifier}`);
          continue;
        }

        const fulfillmentOrderId = openFulfillmentOrder.node.id;

        // 2. Create Fulfillment
        const fulfillmentInput = {
          lineItemsByFulfillmentOrder: [
            {
              fulfillmentOrderId: fulfillmentOrderId,
            }
          ],
          trackingInfo: {
            number: trackingNumber,
            company: trackingCompany
          }
        };

        // If company is not provided or invalid, Shopify infers or you can set "Other".
        // If trackingCompany is possibly empty, we might just omit it or rely on Shopify detection.
        if (!trackingCompany) {
          delete fulfillmentInput.trackingInfo.company;
        }

        const fulfillmentResponse = await admin.graphql(
          `mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
                  fulfillmentCreateV2(fulfillment: $fulfillment) {
                    fulfillment {
                      id
                      status
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }`,
          { variables: { fulfillment: fulfillmentInput } }
        );

        const fulfillmentJson = await fulfillmentResponse.json();
        const userErrors = fulfillmentJson.data?.fulfillmentCreateV2?.userErrors;

        if (userErrors && userErrors.length > 0) {
          results.fail++;
          results.errors.push(`Failed to fulfill ${orderIdentifier}: ${userErrors[0].message}`);
        } else {
          results.success++;
        }

      } catch (err) {
        console.error(err);
        results.fail++;
        results.errors.push(`Error processing ${orderIdentifier}: ${err.message}`);
      }
    }

    // Cap errors to avoid huge JSON
    if (results.errors.length > 50) {
      results.errors = results.errors.slice(0, 50);
      results.errors.push("...and more errors.");
    }

    return json({ status: "success", results });

  } catch (error) {
    console.error(error);
    return json({ status: "error", message: "Server error: " + error.message });
  }
};

export default function Index() {
  const fetcher = useFetcher();
  const [file, setFile] = useState(null);
  const shopify = useAppBridge();

  const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";
  const actionData = fetcher.data;

  useEffect(() => {
    if (actionData?.status === "success") {
      shopify.toast.show(`Synced! Success: ${actionData.results.success}, Failed: ${actionData.results.fail}`);
    } else if (actionData?.status === "error") {
      shopify.toast.show(actionData.message, { isError: true });
    }
  }, [actionData, shopify]);

  // Handle Sample Download
  const loadData = fetcher.data;
  useEffect(() => {
    if (loadData?.csvContent) {
      const blob = new Blob([loadData.csvContent], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = "sample_orders.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      shopify.toast.show("Sample file downloaded");
    }
  }, [loadData, shopify]);

  const handleDrop = useCallback((_droppedFiles, acceptedFiles, _rejectedFiles) => {
    setFile(acceptedFiles[0]);
  }, []);

  const handleSubmit = () => {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    fetcher.submit(formData, { method: "POST", encType: "multipart/form-data" });
  };

  return (
    <Page>
      <TitleBar title="Vibita Tracking" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingMd">
                  Bulk Tracking Upload
                </Text>
                <Text variant="bodyMd" as="p">
                  Upload your CSV, Excel, or TXT file to sync tracking numbers to Shopify orders.
                  Ensure your file has columns for <b>Order Name</b> (e.g. #1001) and <b>Tracking Number</b>.
                </Text>

                <InlineStack align="start">
                  <Button
                    onClick={() => fetcher.load("/app?index&action=download_sample")}
                    variant="tertiary"
                    loading={fetcher.state === "loading" && fetcher.formMethod === "GET"}
                  >
                    Download Sample File
                  </Button>
                </InlineStack>

                <DropZone onDrop={handleDrop} allowMultiple={false} accept=".csv, .xlsx, .xls, .txt" disabled={isLoading}>
                  {file ? (
                    <BlockStack gap="200" align="center" inlineAlign="center">
                      <Thumbnail
                        size="small"
                        alt={file.name}
                        source={NoteIcon}
                      />
                      <Text variant="bodyMd" as="span">
                        {file.name}
                      </Text>
                    </BlockStack>
                  ) : (
                    <DropZone.FileUpload actionHint="Accepts .csv, .xlsx, .txt" />
                  )}
                </DropZone>

                <InlineStack align="end">
                  <Button
                    variant="primary"
                    onClick={handleSubmit}
                    disabled={!file || isLoading}
                    loading={isLoading}
                  >
                    Start Import
                  </Button>
                </InlineStack>

                {actionData && (
                  <BlockStack gap="200">
                    {actionData.status === 'success' && (
                      <Banner title="Import Completed" tone="success">
                        <p>Successfully synced <b>{actionData.results.success}</b> orders.</p>
                        <p>Failed: <b>{actionData.results.fail}</b></p>
                      </Banner>
                    )}
                    {actionData.status === 'error' && (
                      <Banner title="Import Failed" tone="critical">
                        <p>{actionData.message}</p>
                      </Banner>
                    )}
                    {actionData.results?.errors?.length > 0 && (
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingSm">Error Log</Text>
                          <List type="bullet">
                            {actionData.results.errors.map((err, i) => (
                              <List.Item key={i}>{err}</List.Item>
                            ))}
                          </List>
                        </BlockStack>
                      </Card>
                    )}
                  </BlockStack>
                )}

              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
