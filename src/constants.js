'use strict'

// FEATURE: Service Versioning - All nodes must use same version to find each other
const VERSION = '1.0.0';
const SERVICE_BASE_NAME = 'orderBook_service';

module.exports = {
  // Main RPC service for order submission with load balancing
  SERVICE_NAME: `${SERVICE_BASE_NAME}:${VERSION}`,

  // Pub/Sub channel for broadcasting orders and trade updates
  ORDER_BOOK_BROADCAST: `orderBook_broadcast:${VERSION}`,

  // State synchronization service for new nodes joining
  ORDER_BOOK_SYNC: `orderBook_sync:${VERSION}`,

  // Trade history query service
  ORDER_BOOK_HISTORY: `orderBook_history:${VERSION}`,
};