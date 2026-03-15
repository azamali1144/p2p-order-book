'use strict'

const crypto = require('crypto');

class MatchingEngine {
  constructor() {
    this.storage = {};
    this.history = {
      trades: []
    };
    this.lastUpdatedAt = Date.now();
  }

  initPair(symbol) {
    if (!this.storage[symbol]) {
      this.storage[symbol] = { asks: [], bids: [] };
    }
  }

  // FEATURE: Add order and trigger matching
  addOrder(order) {
    const { symbol, side } = order;
    this.initPair(symbol);

    const book = this.storage[symbol];

    if (side === 'sell') {
      book.asks.push({ ...order });
      book.asks.sort((a, b) => a.price - b.price || a.timestamp - b.timestamp);
    } else {
      book.bids.push({ ...order });
      book.bids.sort((a, b) => b.price - a.price || a.timestamp - b.timestamp);
    }

    // FIX: Call match and return the result
    const trades = this.match(symbol);
    return { trades, symbol };
  }

  // FEATURE: Partial Fills - Match orders with quantity consideration
  match(symbol) {
    const trades = [];
    const book = this.storage[symbol];
    if (!book) return trades;

    const { bids, asks } = book;

    // Standard limit order matching: buy price >= sell price
    while (bids.length && asks.length && (bids[0].price >= asks[0].price)) {
      const buy = bids[0];
      const sell = asks[0];

      // FEATURE: Partial Fills
      const amount = Math.min(buy.amount, sell.amount);

      const trade = {
        id: crypto.randomBytes(8).toString('hex'),
        symbol,
        timestamp: Date.now(),
        takerSide: buy.timestamp > sell.timestamp ? 'buy' : 'sell',
        buyOrderId: buy.id,
        sellOrderId: sell.id,
        amount,
        price: sell.price,
      };

      trades.push(trade);

      // Reduce quantities
      buy.amount -= amount;
      sell.amount -= amount;

      // Remove fully filled orders
      if (buy.amount <= 0) bids.shift();
      if (sell.amount <= 0) asks.shift();
    }

    this.lastUpdatedAt = Date.now();
    return trades;
  }

  // FEATURE: Handle remote trade execution (prevent double spending)
  processExternalTrade(trade) {
    const { symbol, buyOrderId, sellOrderId, amount } = trade;
    const book = this.storage[symbol];
    if (!book) return false;

    // Find and reduce buy order
    const buyOrder = book.bids.find(o => o.id === buyOrderId);
    if (buyOrder) {
      buyOrder.amount -= amount;
      if (buyOrder.amount <= 0) {
        this.removeOrderFromBook(symbol, 'bids', buyOrderId);
      }
    }

    // Find and reduce sell order
    const sellOrder = book.asks.find(o => o.id === sellOrderId);
    if (sellOrder) {
      sellOrder.amount -= amount;
      if (sellOrder.amount <= 0) {
        this.removeOrderFromBook(symbol, 'asks', sellOrderId);
      }
    }

    // Record in trade history
    this.history.trades.unshift({
      ...trade,
      id: `remote_${trade.id}`,
      executedAt: Date.now()
    });

    if (this.history.trades.length > 100) this.history.trades.pop();

    this.lastUpdatedAt = Date.now();
    return true;
  }

  removeOrderFromBook(symbol, side, orderId) {
    if (this.storage[symbol] && this.storage[symbol][side]) {
      this.storage[symbol][side] = this.storage[symbol][side].filter(o => o.id !== orderId);
    }
  }

  // FEATURE: Trade History - Return recent trades
  getTradeHistory() {
    return this.history.trades.slice(0, 20);
  }

  // Record successful trade
  recordTrade(trade) {
    this.history.trades.unshift(trade);
    if (this.history.trades.length > 100) {
      this.history.trades.pop();
    }
    return trade;
  }

  getState() {
    return {
      storage: this.storage,
      history: this.history,
      lastUpdatedAt: this.lastUpdatedAt
    };
  }

  setState(state) {
    if (!state) return;
    this.storage = state.storage || {};
    this.history = state.history || { trades: [] };
    this.lastUpdatedAt = state.lastUpdatedAt || Date.now();
  }
}

module.exports = MatchingEngine;