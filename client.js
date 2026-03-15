'use strict'

const { SERVICE_NAME, ORDER_BOOK_HISTORY, ORDER_BOOK_BROADCAST } = require('./src/constants');
const { PeerRPCClient, PeerSub } = require('grenache-nodejs-ws');
const Link = require('grenache-nodejs-link');
const crypto = require('crypto');
require('dotenv').config();

class OrderBookClient {
  constructor(config) {
    this.lnk = new Link({ grape: config.grape, timeout: config.timeout });
    this.peerRpcClient = new PeerRPCClient(this.lnk, {});
    this.peerSub = new PeerSub(this.lnk, {});

    // Parse command line args
    const [symbol, price, amount, side] = process.argv.slice(2);

    this.order = {
      id: crypto.randomBytes(8).toString('hex'),
      symbol: symbol || 'BTC/USD',
      price: parseFloat(price) || 50000,
      amount: parseFloat(amount) || 0.1,
      side: side || 'buy',
      timestamp: Date.now()
    };
  }

  init() {
    this.lnk.start();
    this.peerRpcClient.init();
    this.peerSub.init();

    // Start listening for trades
    this.subscribeToTrades();

    // Fetch history
    setTimeout(() => this.fetchHistory(), 1000);

    // Submit order
    setTimeout(() => {
      console.log(`\n[Client] Submitting: ${this.order.side.toUpperCase()} ${this.order.amount} ${this.order.symbol} @ $${this.order.price}\n`);
      this.submitOrder(this.order);
    }, 1500);
  }

  // FEATURE: Load Balancing
  submitOrder(order) {
    console.log(`[Client] Looking for available peers...`);

    this.peerRpcClient.request(
      SERVICE_NAME,
      order,
      { timeout: parseInt(process.env.ORDER_BOOK_SERVICE_TIMEOUT) || 10000 },
      (err, result) => {
        if (err) {
          if (err.message === 'ERR_GRAPE_LOOKUP_EMPTY') {
            console.error('[Error] No peers online. Retrying in 2 seconds...');
            setTimeout(() => this.submitOrder(order), 2000);
            return;
          }

          if (err.code === 'ECONNREFUSED' || err.message === 'ERR_TIMEOUT') {
            console.warn('[Retry] Peer unreachable. Trying another...');
            this.submitOrder(order);
            return;
          }

          console.error('[Error] Order submission failed:', err.message);
          return;
        }

        console.log(`[Success] Order accepted!`);
        console.log(`   Peer: ${result.peer}`);
        console.log(`   Matches: ${result.matches}\n`);
      }
    );
  }

  // FEATURE: Trade History Query
  fetchHistory() {
    this.peerRpcClient.request(
      ORDER_BOOK_HISTORY,
      {},
      { timeout: parseInt(process.env.ORDER_BOOK_HISTORY_TIMEOUT) || 5000 },
      (err, history) => {
        if (err) {
          console.error('[History] Query failed:', err.message);
          return;
        }

        if (!history || history.length === 0) {
          console.log('[History] No trades yet.\n');
          return;
        }

        console.log('═══════════════════════════════════════════════════════════');
        console.log('                    RECENT TRADE HISTORY                    ');
        console.log('═══════════════════════════════════════════════════════════');
        history.forEach((t, i) => {
          const time = new Date(t.timestamp).toLocaleTimeString();
          console.log(`  ${i + 1}. ${t.symbol} | ${t.amount} @ $${t.price} | ${time}`);
        });
        console.log('═══════════════════════════════════════════════════════════\n');
      }
    );
  }

  // FEATURE: Real-Time Trade Stream
  subscribeToTrades() {
    this.peerSub.sub(ORDER_BOOK_BROADCAST, {
      timeout: parseInt(process.env.ORDER_BOOK_BROADCAST_TIMEOUT) || 10000
    });

    this.peerSub.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === 'TRADE_BATCH') {
          msg.trades.forEach(t => {
            console.log(`🚀 [LIVE TRADE] ${t.symbol} | ${t.amount} @ $${t.price}`);
          });
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    this.peerSub.on('error', (err) => {
      if (err.message === 'ERR_GRAPE_LOOKUP_EMPTY') return;
      console.error('[Stream] Error:', err.message);
    });
  }
}

const client = new OrderBookClient({
  grape: `${process.env.GRPES_BASE_URL}:${process.env.GRPES_PORT}`,
  timeout: parseInt(process.env.GRPES_TIMEOUT)
});

client.init();