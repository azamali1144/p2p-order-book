'use strict'

const fs = require('fs');

// FEATURE: No Central Authority - Each peer has its own storage
class Storage {
  constructor(peerId) {
    this.path = `./peer_${peerId}_db.json`;
  }

  // FEATURE: Performance - Async write to prevent blocking event loop
  save(data) {
    const json = JSON.stringify(data, null, 2);
    fs.writeFile(this.path, json, (err) => {
      if (err) console.error(`[Storage] Save failed: ${err.message}`);
    });
  }

  load() {
    if (fs.existsSync(this.path)) {
      try {
        return JSON.parse(fs.readFileSync(this.path, 'utf8'));
      } catch (e) {
        console.warn('[Storage] Corrupted DB file, starting fresh.');
        return null;
      }
    }
    return null;
  }
}

module.exports = Storage;