'use strict'

process.on('uncaughtException', (err) => {
  if (err.message === 'ERR_GRAPE_LOOKUP_EMPTY') return;
  console.error('[Fatal]', err);
  process.exit(1);
});

require('dotenv').config();
const OrderBookPeer = require('./src/peer');

const peer = new OrderBookPeer({
  grape: `${process.env.GRPES_BASE_URL}:${process.env.GRPES_PORT}`,
  timeout: parseInt(process.env.GRPES_TIMEOUT)
});

peer.init();

process.on('SIGINT', () => {
  console.log('\n[Main] SIGINT - shutting down gracefully...');
  peer.stop();
});

process.on('SIGTERM', () => {
  console.log('[Main] SIGTERM - shutting down gracefully...');
  peer.stop();
});