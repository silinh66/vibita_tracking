import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";

export const action = async ({ request }) => {
    const { topic, shop, payload, admin } = await authenticate.webhook(request);

    // These webhooks are mandatory for public apps.
    // Since this app does not store PII in its own database (it only syncs tracking to Shopify),
    // we can simply acknowledge these requests.

    // topics: 
    // CUSTOMERS_DATA_REQUEST: Request all data for a customer
    // CUSTOMERS_REDACT: Delete data for a customer
    // SHOP_REDACT: Delete data for a shop (48 hours after uninstall)

    switch (topic) {
        case "CUSTOMERS_DATA_REQUEST":
        case "CUSTOMERS_REDACT":
        case "SHOP_REDACT":
            console.log(`Received GDPR webhook: ${topic} for ${shop}`);
            break;
        default:
            console.log(`Received ${topic} webhook for ${shop}`);
    }

    return new Response("OK", { status: 200 });
};
