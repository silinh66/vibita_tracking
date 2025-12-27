module.exports = {
    apps: [
        {
            name: "app.vibita",
            // Trỏ thẳng vào file chạy của remix-serve trong node_modules
            script: "./node_modules/.bin/remix-serve.cmd",

            // Đường dẫn đến file build của bạn
            args: "./build/server/index.js",

            // Quan trọng: Báo PM2 đây là file binary, không phải JS thuần
            interpreter: "none",
            env_file: ".env",
            env: {
                PORT: 5188,
                NODE_ENV: "production"
            }
        }
    ]
};