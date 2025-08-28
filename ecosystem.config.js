module.exports = {
  apps: [
    {
      name: 'print-service',
      script: 'src/print.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        API_URL: 'http://localhost:8081',
        RESTAURANT_ID: '68ac8a5f066bb634561fd848'
      },
    },
  ],
};
