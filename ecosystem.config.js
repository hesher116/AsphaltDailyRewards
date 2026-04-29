module.exports = {
  apps: [
    {
      name: 'asphalt-daily-rewards',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        HEADLESS: 'true',
        DEBUG: 'false'
      }
    }
  ]
};
