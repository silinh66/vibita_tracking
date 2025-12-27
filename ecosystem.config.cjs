module.exports = {
    apps: [
        {
            name: "vibita tracking",
            script: "npm",
            args: "run start",
            interpreter: "none", // <--- THÊM DÒNG QUAN TRỌNG NÀY
            env: {
                PORT: 5188,
                NODE_ENV: "production"
            }
        }
    ]
};