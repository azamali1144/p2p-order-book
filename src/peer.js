'use strict'

const {
  SERVICE_NAME,
  ORDER_BOOK_SYNC,
  ORDER_BOOK_HISTORY,
  ORDER_BOOK_BROADCAST
} = require('./constants');

const {
  PeerSub,
  PeerPub,
  PeerRPCServer,
  PeerRPCClient
} = require('grenache-nodejs-ws');

require('dotenv').config();
const crypto = require('crypto');
const fastq = require('fastq');
const Storage = require('./storage');
const Link = require('grenache-nodejs-link');
const MatchingEngine = require('./engine');

class OrderBookPeer {
  constructor(config) {
    this.peerId = crypto.randomBytes(4).toString('hex');
    this.lnk = new Link({ grape: config.grape, timeout: config.timeout });

    this.engine = new MatchingEngine();
    this.db = new Storage(this.peerId);

    // FEATURE: Deduplication cache
    this.processedIds = new Set();

    this.peerSub = new PeerSub(this.lnk, {});
    this.peerPub = new PeerPub(this.lnk, {});
    this.peerRpcServer = new PeerRPCServer(this.lnk, {});
    this.peerRpcClient = new PeerRPCClient(this.lnk, {});

    // For split-brain resolution
    this.lastLocalMatchTimestamp = Date.now();

    // FEATURE: Random ports for multiple instances
    this.ports = {
      pub: Math.floor(Math.random() * 1000) + 10001,
      rpc: Math.floor(Math.random() * 1000) + 11001
    };

    // FEATURE: Performance - Queue for handling 1000+ orders/sec
    this.queue = fastq.promise(this, this.worker, 1);

    // FEATURE: Performance - Micro-batching
    this.tradeBuffer = [];
    this.announceInterval = null;
  }

  init() {
    this.lnk.start();
    [this.peerRpcServer, this.peerSub, this.peerPub, this.peerRpcClient].forEach(p => p.init());

    // Load persisted state
    const saved = this.db.load();
    if (saved) this.engine.setState(saved);

    this.setupTransports();
    this.setupSubscriptions();
    this.setupDiscoveryLogic();
    this.startAnnouncing();
    this.setupBatchProcessor();

    // Bootstrap after DHT registration
    setTimeout(() => this.bootstrap(), 2000);
    console.log(`[Peer ${this.peerId}] Running on RPC: ${this.ports.rpc}, PUB: ${this.ports.pub}\n`);
  }

  // FEATURE: Sequential processing to prevent race conditions
  async worker(order) {
    order.id = order.id || crypto.randomBytes(8).toString('hex');

    console.log('order: ', order);
    // Only set originPeer if not already set
    if (!order.originPeer) order.originPeer = this.peerId;

    // FEATURE: Idempotency check
    if (this.processedIds.has(order.id)) {
      console.log(`[Worker] Skipping duplicate order: ${order.id}`);
      return [];
    }
    this.processedIds.add(order.id);

    // Run matching engine
    const result = this.engine.addOrder(order);
    console.log('result: ', result);

    const trades = result.trades || [];

    console.log(`[Worker] Order ${order.id.slice(0, 8)}: ${trades.length} trades matched`);

    if (trades && trades.length > 0) {
      // Record trades in history
      trades.forEach(t => this.engine.recordTrade(t));

      // Add to batch buffer
      this.tradeBuffer.push(...trades);

      // Persist state
      this.db.save(this.engine.getState());
      this.lastLocalMatchTimestamp = Date.now();
    }

    // FEATURE: Gossip new orders
    if (order.originPeer === this.peerId) {
      this.peerPub.pub(JSON.stringify({ type: 'LIMIT_ORDER', ...order }));
    }

    return trades;
  }

  // FEATURE: Micro-batching reduces network overhead
  setupBatchProcessor() {
    setInterval(() => {
      if (this.tradeBuffer.length === 0) return;

      const batch = this.tradeBuffer.splice(0, this.tradeBuffer.length);

      const payload = {
        type: 'TRADE_BATCH',
        originPeer: this.peerId,
        trades: batch,
        timestamp: Date.now()
      };

      this.peerPub.pub(JSON.stringify(payload));
      console.log(`[Batch] Broadcasted ${batch.length} trades`);
    }, 100);
  }

  setupTransports() {
    // Start Pub/Sub server
    const pubService = this.peerPub.transport('client');
    pubService.listen(this.ports.pub);

    // Start RPC server
    const rpcService = this.peerRpcServer.transport('server');
    rpcService.listen(this.ports.rpc);

    rpcService.on('request', (rid, key, payload, handler) => {
      // ORDER SUBMISSION
      if (key === SERVICE_NAME) {
        this.queue.push(payload)
          .then(trades => handler.reply(null, {
            status: 'PROCESSED',
            trades: trades.length,
            peer: this.peerId
          }))
          .catch(err => handler.reply(err));
        return;
      }

      // STATE SNAPSHOT / BOOTSTRAP
      if (key === ORDER_BOOK_SYNC) {
        console.log(`[RPC] Providing state snapshot to new peer`);
        return handler.reply(null, this.engine.getState());
      }

      // TRADE HISTORY
      if (key === ORDER_BOOK_HISTORY) {
        return handler.reply(null, this.engine.getTradeHistory());
      }

      console.warn(`[RPC] Unknown key: ${key}`);
    });
  }

  setupSubscriptions() {
    const subscribe = () => {
      this.peerSub.sub(ORDER_BOOK_BROADCAST, {
        timeout: parseInt(process.env.ORDER_BOOK_BROADCAST_TIMEOUT) || 10000
      });
    };

    subscribe();
    setInterval(subscribe, 5000); // Health check

    this.peerSub.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        // Handle new order broadcasts
        if (data.type === 'LIMIT_ORDER') {
          if (!this.processedIds.has(data.id)) {
            console.log(`[Gossip] Received order ${data.id.slice(0, 8)}`);
            this.queue.push(data).catch(() => {});
          }
        }

        // FEATURE: Split-Brain Resolution - Handle trade batches
        if (data.type === 'TRADE_BATCH') {
          console.log(`[Gossip] Trade batch: ${data.trades.length} trades from ${data.originPeer.slice(0, 8)}`);

          data.trades.forEach(trade => {
            // Tie-breaker: earlier timestamp or smaller peer ID wins
            const isEarlier = trade.timestamp < this.lastLocalMatchTimestamp;
            const isTieAndSmaller = trade.timestamp === this.lastLocalMatchTimestamp &&
              data.originPeer < this.peerId;

            if (isEarlier || isTieAndSmaller) {
              const success = this.engine.processExternalTrade(trade);
              if (success) this.db.save(this.engine.getState());
            }
          });
        }

      } catch (e) {
        console.error('[Gossip] Parse error:', e.message);
      }
    });

    this.peerSub.on('error', (err) => {
      if (err.message === 'ERR_GRAPE_LOOKUP_EMPTY') return;
      console.error('[Gossip] Error:', err.message);
    });
  }

  // FEATURE: Dynamic Peer Discovery
  startAnnouncing() {
    this.announceInterval = setInterval(() => {
      this.lnk.announce(SERVICE_NAME, this.ports.rpc, (err) => {
        if (err) console.error('[DHT] SERVICE_NAME announce failed');
      });

      this.lnk.announce(ORDER_BOOK_BROADCAST, this.ports.pub, (err) => {
        if (err) console.error('[DHT] BROADCAST announce failed');
      });

      this.lnk.announce(ORDER_BOOK_SYNC, this.ports.rpc, (err) => {
        if (err) console.error('[DHT] SYNC announce failed');
      });
    }, 1000);
  }

  setupDiscoveryLogic() {
    this.peerSub.on('error', (err) => {
      if (err.message === 'ERR_GRAPE_LOOKUP_EMPTY') return;
      console.error('[Discovery] Error:', err.message);
    });
  }

  // FEATURE: Bootstrap with state sync
  bootstrap() {
    console.log(`[Bootstrap] Looking up peers for state sync...`);

    this.peerRpcClient.request(ORDER_BOOK_SYNC, { requester: this.peerId }, {
      timeout: parseInt(process.env.ORDER_BOOK_SYNC_TIMEOUT) || 10000
    }, (err, networkState) => {
      if (err) {
        if (err.message === 'ERR_GRAPE_LOOKUP_EMPTY') {
          console.log('[Bootstrap] No peers found - starting as Genesis node');
        } else {
          console.error('[Bootstrap] Sync failed:', err.message);
        }
        return;
      }

      if (networkState && this.isNetworkStateNewer(networkState)) {
        console.log('[Bootstrap] Applying network state snapshot');
        this.engine.setState(networkState);
        this.db.save(networkState);
        console.log('[Bootstrap] State synchronized\n');
      }
    });
  }

  isNetworkStateNewer(networkState) {
    if (!networkState || !networkState.lastUpdatedAt) return false;

    const isMoreRecent = networkState.lastUpdatedAt > this.engine.lastUpdatedAt;

    const localSize = JSON.stringify(this.engine.storage).length;
    const networkSize = JSON.stringify(networkState.storage || {}).length;
    const isLarger = networkState.lastUpdatedAt === this.engine.lastUpdatedAt &&
      networkSize > localSize;

    return isMoreRecent || isLarger;
  }

  // FEATURE: Graceful Shutdown
  stop() {
    console.log(`\n[Peer ${this.peerId}] Graceful shutdown...`);

    // Stop announcements
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
    }

    // Persist final state
    this.db.save(this.engine.getState());

    // Close transports safely
    try {
      if (this.peerRpcServer && typeof this.peerRpcServer.stop === 'function') {
        this.peerRpcServer.stop();
      }
      if (this.peerSub && typeof this.peerSub.stop === 'function') {
        this.peerSub.stop();
      }
      if (this.peerPub && typeof this.peerPub.stop === 'function') {
        this.peerPub.stop();
      }
      if (this.peerRpcClient && typeof this.peerRpcClient.stop === 'function') {
        this.peerRpcClient.stop();
      }
      if (this.lnk && typeof this.lnk.stop === 'function') {
        this.lnk.stop();
      }
    } catch (e) {
      console.warn('[Shutdown] Error closing transports');
    }

    console.log('[Shutdown] Peer offline. Goodbye.\n');
    process.exit(0);
  }
}

module.exports = OrderBookPeer;