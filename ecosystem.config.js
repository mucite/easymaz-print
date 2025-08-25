module.exports = {
  apps: [
    {
      name: 'print-service',
      script: 'src/print.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        API_URL: 'http://localhost:8081'
      },
    },
  ],
};
