// pm2 config for the bot and the flow builder.
//   pm2 start ecosystem.config.js
// Ports match deploy/nginx/gdn-whatsapp.conf.sample. Other settings come from .env.

module.exports = {
  apps: [
    {
      name: 'wa-bot',
      script: 'src/server.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production', PORT: 3200 },
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'wa-builder',
      script: 'builder/server.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production', BUILDER_PORT: 3100 },
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
