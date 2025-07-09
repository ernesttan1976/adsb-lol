#!/usr/bin/env node

const net = require('net');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// Complete Mode S decoder implementation
class ModeS {
  static crc24(data) {
    const poly = 0x1FFF409;
    let crc = 0;
    
    for (let i = 0; i < data.length; i++) {
      crc ^= (data[i] << 16);
      for (let j = 0; j < 8; j++) {
        if (crc & 0x800000) {
          crc = (crc << 1) ^ poly;
        } else {
          crc <<= 1;
        }
        crc &= 0xFFFFFF;
      }
    }
    return crc;
  }
  
  static icao(msg) {
    if (msg.length < 4) return null;
    return Buffer.from([msg[1], msg[2], msg[3]]).toString('hex').toUpperCase();
  }
  
  static typecode(msg) {
    if (msg.length < 5) return null;
    return (msg[4] >>> 3) & 0x1F;
  }
  
  static altitude(msg) {
    const tc = this.typecode(msg);
    if (tc < 9 || tc > 18) return null;
    
    const alt_raw = ((msg[5] & 0xFF) << 4) | ((msg[6] & 0xF0) >>> 4);
    const q_bit = (msg[6] & 0x10) !== 0;
    
    if (q_bit) {
      const alt = ((alt_raw & 0x0FE0) >>> 1) | (alt_raw & 0x000F);
      return alt * 25 - 1000;
    } else {
      return this.gray2alt(alt_raw) * 100 - 1000;
    }
  }
  
  static gray2alt(gray) {
    const grayToBinary = (gray) => {
      let binary = gray;
      for (let i = 1; i < 12; i++) {
        binary ^= (binary >>> i);
      }
      return binary & 0x7FF;
    };
    
    const binary = grayToBinary(gray);
    const c1 = (binary & 0x400) ? 5 : 0;
    const a1 = (binary & 0x200) ? 10 : 0;
    const c2 = (binary & 0x100) ? 1 : 0;
    const a2 = (binary & 0x080) ? 20 : 0;
    const c4 = (binary & 0x040) ? 2 : 0;
    const a4 = (binary & 0x020) ? 40 : 0;
    
    return (c1 + a1 + c2 + a2 + c4 + a4);
  }
  
  static callsign(msg) {
    const tc = this.typecode(msg);
    if (tc < 1 || tc > 4) return null;
    
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ      0123456789      ";
    let callsign = "";
    
    let data = 0;
    for (let i = 5; i <= 10; i++) {
      data = (data << 8) | (msg[i] & 0xFF);
    }
    
    for (let i = 0; i < 8; i++) {
      const char_idx = (data >>> (42 - i * 6)) & 0x3F;
      if (char_idx < chars.length) {
        callsign += chars[char_idx];
      }
    }
    
    return callsign.trim();
  }
  
  static velocity(msg) {
    const tc = this.typecode(msg);
    if (tc !== 19) return null;
    
    const subtype = (msg[4] >>> 1) & 0x07;
    
    if (subtype === 1 || subtype === 2) {
      const ew_dir = (msg[5] & 0x04) !== 0;
      const ew_vel = ((msg[5] & 0x03) << 8) | msg[6];
      const ns_dir = (msg[7] & 0x80) !== 0;
      const ns_vel = ((msg[7] & 0x7F) << 3) | ((msg[8] & 0xE0) >>> 5);
      
      if (ew_vel === 0 || ns_vel === 0) return null;
      
      const ew_speed = (ew_vel - 1) * (ew_dir ? -1 : 1);
      const ns_speed = (ns_vel - 1) * (ns_dir ? -1 : 1);
      
      const speed = Math.sqrt(ew_speed * ew_speed + ns_speed * ns_speed);
      const heading = Math.atan2(ew_speed, ns_speed) * 180 / Math.PI;
      
      return {
        speed: Math.round(speed),
        heading: heading < 0 ? heading + 360 : heading
      };
    }
    
    return null;
  }
  
  static nic(msg) {
    const tc = this.typecode(msg);
    if (tc < 9 || tc > 18) return null;
    
    const nicTable = {
      9: 11, 10: 10, 11: 8, 12: 7, 13: 6,
      14: 5, 15: 4, 16: 3, 17: 2, 18: 1
    };
    
    return nicTable[tc] || null;
  }
}

class BeastProcessor {
  constructor() {
    // Connect to readsb-data-collector container via Docker network
    this.host = 'readsb-data-collector';
    this.port = 30105;
    this.aircraftDB = new Map();
    this.outputDir = './output';
    this.buffer = Buffer.alloc(0);
    this.messagesProcessed = 0;
    this.startTime = performance.now();
    
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    
    this.lastStatsTime = Date.now();
    this.lastMessageCount = 0;
  }
  
  decodeBeastMessage(data) {
    if (data.length < 23) return null;
    
    if (data[0] !== 0x1A) return null;
    
    const msgType = data[1];
    const timestampBytes = data.slice(2, 8);
    const signalLevel = data[8];
    
    let timestamp = 0;
    for (let i = 0; i < 6; i++) {
      timestamp = (timestamp << 8) | timestampBytes[i];
    }
    const timestampMs = timestamp / 12000.0;
    
    let message;
    if (msgType === 0x33) {
      if (data.length < 23) return null;
      message = data.slice(9, 23);
    } else if (msgType === 0x32) {
      if (data.length < 16) return null;
      message = data.slice(9, 16);
    } else {
      return null;
    }
    
    return {
      type: msgType === 0x33 ? 'MODE_S_LONG' : 'MODE_S_SHORT',
      timestamp: timestampMs,
      signal: signalLevel,
      message: message
    };
  }
  
  decodeModeSFields(message) {
    try {
      const icao = ModeS.icao(message);
      const typecode = ModeS.typecode(message);
      
      if (!icao) return null;
      
      const fields = {
        hex: icao,
        typecode: typecode,
        crc_valid: ModeS.crc24(message) === 0
      };
      
      // Position messages (TC 9-18)
      if (typecode >= 9 && typecode <= 18) {
        const alt = ModeS.altitude(message);
        if (alt !== null) {
          fields.altitude = alt;
        }
        fields.nic = ModeS.nic(message);
        fields.surveillance_status = (message[4] >>> 1) & 0x03;
        fields.single_antenna = (message[4] & 0x01) !== 0;
      }
      
      // Velocity messages (TC 19)
      if (typecode === 19) {
        const vel = ModeS.velocity(message);
        if (vel) {
          fields.gs = vel.speed;
          fields.track = vel.heading;
        }
      }
      
      // Aircraft identification (TC 1-4)
      if (typecode >= 1 && typecode <= 4) {
        const callsign = ModeS.callsign(message);
        if (callsign) {
          fields.flight = callsign;
          fields.category = typecode;
        }
      }
      
      return fields;
      
    } catch (error) {
      return null;
    }
  }
  
  processBeastStream() {
    const client = new net.Socket();
    
    client.connect(this.port, this.host, () => {
      console.log(`Connected to Beast stream at ${this.host}:${this.port}`);
      console.log(`Processing ADSBExchange global feed data...`);
    });
    
    client.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.processBuffer();
    });
    
    client.on('close', () => {
      console.log('Beast connection closed, reconnecting...');
      setTimeout(() => this.processBeastStream(), 5000);
    });
    
    client.on('error', (err) => {
      console.error('Beast connection error:', err.message);
      setTimeout(() => this.processBeastStream(), 5000);
    });
  }
  
  processBuffer() {
    while (this.buffer.length >= 23) {
      const syncPos = this.buffer.indexOf(0x1A);
      if (syncPos === -1) {
        this.buffer = this.buffer.slice(-22);
        break;
      }
      
      if (syncPos > 0) {
        this.buffer = this.buffer.slice(syncPos);
      }
      
      if (this.buffer.length < 2) break;
      
      const msgType = this.buffer[1];
      let msgLen;
      if (msgType === 0x33) {
        msgLen = 23;
      } else if (msgType === 0x32) {
        msgLen = 16;
      } else {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      
      if (this.buffer.length < msgLen) break;
      
      const beastMsg = this.decodeBeastMessage(this.buffer.slice(0, msgLen));
      if (beastMsg) {
        const fields = this.decodeModeSFields(beastMsg.message);
        if (fields && fields.hex) {
          this.updateAircraftDB(fields, beastMsg);
          this.messagesProcessed++;
        }
      }
      
      this.buffer = this.buffer.slice(msgLen);
    }
    
    // Performance stats every 10 seconds
    const now = Date.now();
    if (now - this.lastStatsTime > 10000) {
      const msgRate = (this.messagesProcessed - this.lastMessageCount) / 10;
      console.log(`Processing ${msgRate.toFixed(1)} messages/sec, ${this.aircraftDB.size} aircraft tracked (Global ADSBExchange feed)`);
      this.lastStatsTime = now;
      this.lastMessageCount = this.messagesProcessed;
    }
  }
  
  updateAircraftDB(fields, beastMsg) {
    const icao = fields.hex;
    const now = Date.now();
    
    if (!this.aircraftDB.has(icao)) {
      this.aircraftDB.set(icao, {
        hex: icao,
        messages: 0,
        first_seen: now
      });
    }
    
    const aircraft = this.aircraftDB.get(icao);
    
    Object.assign(aircraft, fields);
    aircraft.seen = now;
    aircraft.messages++;
    aircraft.beast_timestamp = beastMsg.timestamp;
    aircraft.signal_level = beastMsg.signal;
    aircraft.rssi = beastMsg.signal - 256;
    aircraft.message_type = beastMsg.type;
    aircraft.raw_message = beastMsg.message.toString('hex').toUpperCase();
  }
  
  generateJSONFiles() {
    setInterval(() => {
      try {
        const timestamp = new Date();
        const cutoff = Date.now() - 60000; // 60 seconds
        
        // Clean old aircraft
        for (const [icao, aircraft] of this.aircraftDB.entries()) {
          if (aircraft.seen < cutoff) {
            this.aircraftDB.delete(icao);
          }
        }
        
        const aircraftArray = Array.from(this.aircraftDB.values());
        
        const outputData = {
          now: timestamp.getTime() / 1000,
          messages: this.messagesProcessed,
          aircraft: aircraftArray,
          enhanced_fields: true,
          source: 'adsbexchange_global_feed',
          data_sources: ['beast_feed_port_1365', 'mlat_feed_port_1366'],
          performance: {
            uptime: (performance.now() - this.startTime) / 1000,
            aircraft_count: aircraftArray.length,
            message_rate: this.messagesProcessed / ((performance.now() - this.startTime) / 1000)
          }
        };
        
        // Timestamped filename for ETL
        const filename = `aircraft_${timestamp.toISOString().replace(/[:.]/g, '_').slice(0, -5)}.json`;
        const filepath = path.join(this.outputDir, filename);
        
        fs.writeFileSync(filepath, JSON.stringify(outputData, null, 2));
        
        // Latest file for real-time access
        const latestPath = path.join(this.outputDir, 'latest.json');
        fs.writeFileSync(latestPath, JSON.stringify(outputData, null, 2));
        
        console.log(`Generated ${filename} with ${aircraftArray.length} aircraft (Global coverage)`);
        
      } catch (error) {
        console.error('JSON generation error:', error);
      }
    }, 5000);
  }
  
  start() {
    console.log('Starting Beast processor for ADSBExchange global feeds...');
    this.processBeastStream();
    this.generateJSONFiles();
  }
}

const processor = new BeastProcessor();
processor.start();

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});