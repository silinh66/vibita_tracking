module.exports = {
    apps: [
        {
            name: "vibita-tracking", // Đặt tên app tùy ý
            script: "npm",
            args: "run start", // Nó sẽ gọi lệnh "remix-serve ./build/server/index.js"
            env: {
                PORT: 5188,         // Port bạn muốn
                NODE_ENV: "production",
                // Nếu app cần thêm biến môi trường (API Key...), thêm vào đây:
                // SHOPIFY_API_KEY: "...",
            }
        }
    ]
};