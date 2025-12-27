module.exports = {
    apps: [
        {
            name: "app.vibita",
            // Thay vì gọi npm, ta gọi thẳng cmd của Windows
            script: "C:\\Windows\\System32\\cmd.exe",
            // Truyền lệnh "npm run start" vào cho cmd xử lý
            args: "/c npm run start",
            env: {
                PORT: 5188,
                NODE_ENV: "production"
            }
        }
    ]
};