#!/usr/bin/env node

require('dotenv').config();

const net = require('net');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { latLngToCell } = require('h3-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const nodemailer = require('nodemailer');

function cleanupOldFiles() {
    const enhancedJsonDir = path.join(__dirname, 'output');
    const oneHourAgo = Date.now() - (60 * 60 * 1000); // 1 hour in milliseconds
    
    try {
        // Check if directory exists
        if (!fs.existsSync(enhancedJsonDir)) {
            console.log('Enhanced JSON directory does not exist, skipping cleanup');
            return;
        }
        
        // Read all files in the directory
        const files = fs.readdirSync(enhancedJsonDir);
        let deletedCount = 0;
        
        files.forEach(file => {
            const filePath = path.join(enhancedJsonDir, file);
            
            try {
                const stats = fs.statSync(filePath);
                
                // Check if file is older than 1 hour
                if (stats.mtime.getTime() < oneHourAgo) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            } catch (err) {
                console.error(`Error processing file ${file}:`, err.message);
            }
        });
        
        console.log(`Cleanup completed. Deleted ${deletedCount} old files from enhanced_json folder.`);
        
    } catch (err) {
        console.error('Error during cleanup:', err.message);
    }
}


// Mode S decoder with CPR position decoding
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
  
  static alt_baro(msg) {
    const tc = this.typecode(msg);
    if (tc < 9 || tc > 18) return null;
    
    const alt_code = ((msg[5] & 0xFF) << 4) | ((msg[6] & 0xF0) >> 4);
    if (alt_code === 0) return null;
    
    const alt_baro = alt_code * 25 - 1000;
    return alt_baro;
  }
  
  static velocity(msg) {
    const tc = this.typecode(msg);
    if (tc !== 19) return null;
    
    const st = (msg[4] & 0x07);
    if (st !== 1 && st !== 2) return null; // Only ground speed
    
    const ew_dir = (msg[5] & 0x04) !== 0;
    const ew_vel = ((msg[5] & 0x03) << 8) | msg[6];
    const ns_dir = (msg[7] & 0x80) !== 0;
    const ns_vel = ((msg[7] & 0x7F) << 3) | ((msg[8] & 0xE0) >> 5);
    
    if (ew_vel === 0 || ns_vel === 0) return null;
    
    const ew_speed = (ew_vel - 1) * (ew_dir ? -1 : 1);
    const ns_speed = (ns_vel - 1) * (ns_dir ? -1 : 1);
    
    const gs = Math.sqrt(ew_speed * ew_speed + ns_speed * ns_speed);
    let track = Math.atan2(ew_speed, ns_speed) * 180 / Math.PI;
    if (track < 0) track += 360;
    
    // Vertical rate
    const vr_sign = (msg[8] & 0x08) !== 0;
    const vr_val = ((msg[8] & 0x07) << 6) | ((msg[9] & 0xFC) >> 2);
    const vertical_rate = vr_val === 0 ? null : (vr_val - 1) * 64 * (vr_sign ? -1 : 1);
    
    return {
      gs: Math.round(gs),
      track: Math.round(track * 10) / 10,
      vertical_rate: vertical_rate
    };
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
  
  // Extract CPR data from position message
  static extractCPRData(msg) {
    const tc = this.typecode(msg);
    if (tc < 9 || tc > 18) return null;
    
    const cpr_format = (msg[6] & 0x04) !== 0; // 0 = even, 1 = odd
    const cpr_lat = ((msg[6] & 0x03) << 15) | (msg[7] << 7) | ((msg[8] & 0xFE) >>> 1);
    const cpr_lon = ((msg[8] & 0x01) << 16) | (msg[9] << 8) | msg[10];
    
    return {
      format: cpr_format ? 'odd' : 'even',
      lat: cpr_lat,
      lon: cpr_lon,
      timestamp: Date.now()
    };
  }
  
  // Local CPR decoding
  static cprLocalDecode(refLat, refLon, cprLat, cprLon, isOddFormat) {
    const AirDlat0 = 360.0 / 60;  // even
    const AirDlat1 = 360.0 / 59;  // odd
    
    const dlat = isOddFormat ? AirDlat1 : AirDlat0;
    const j = Math.floor(refLat / dlat) + Math.floor(0.5 + ((refLat % dlat) / dlat) - (cprLat / 131072.0));
    const rlat = dlat * (j + cprLat / 131072.0);
    
    if (rlat >= 270 || rlat <= -270) return null;
    
    const nl = this.cprNL(rlat);
    if (nl === 0) return null;
    
    const dlon = isOddFormat ? 360.0 / Math.max(nl - 1, 1) : 360.0 / Math.max(nl, 1);
    const m = Math.floor(refLon / dlon) + Math.floor(0.5 + ((refLon % dlon) / dlon) - (cprLon / 131072.0));
    let rlon = dlon * (m + cprLon / 131072.0);
    
    // Normalize longitude
    while (rlon > 180) rlon -= 360;
    while (rlon < -180) rlon += 360;
    
    return { lat: rlat, lon: rlon };
  }
  
  // Global CPR decoding
  static cprGlobalDecode(evenFrame, oddFrame) {
    try {
      const AirDlat0 = 360.0 / 60;  // even  
      const AirDlat1 = 360.0 / 59;  // odd
      
      const j = Math.floor(((59 * evenFrame.lat - 60 * oddFrame.lat) / 131072) + 0.5);
      
      const rlat0 = AirDlat0 * (j % 60 + evenFrame.lat / 131072.0);
      const rlat1 = AirDlat1 * (j % 59 + oddFrame.lat / 131072.0);
      
      if (rlat0 >= 270 || rlat0 <= -270 || rlat1 >= 270 || rlat1 <= -270) {
        return null;
      }
      
      const nl0 = this.cprNL(rlat0);
      const nl1 = this.cprNL(rlat1);
      if (nl0 !== nl1) {
        return null;
      }
      
      const lat = (oddFrame.timestamp > evenFrame.timestamp) ? rlat1 : rlat0;
      const nl = this.cprNL(lat);
      if (nl === 0) return null;
      
      const ni = Math.max(nl, 1);
      const dlon0 = 360.0 / ni;
      const dlon1 = 360.0 / Math.max(ni - 1, 1);
      
      const m = Math.floor(((evenFrame.lon * (nl - 1) - oddFrame.lon * nl) / 131072.0) + 0.5);
      
      const lon0 = dlon0 * (m % ni + evenFrame.lon / 131072.0);
      const lon1 = dlon1 * (m % Math.max(ni - 1, 1) + oddFrame.lon / 131072.0);
      
      const normalizeLon = (lon) => {
        while (lon > 180) lon -= 360;
        while (lon < -180) lon += 360;
        return lon;
      };
      
      const lon = normalizeLon((oddFrame.timestamp > evenFrame.timestamp) ? lon1 : lon0);
      
      return { lat, lon };
    } catch (error) {
      return null;
    }
  }
  
  static cprNL(lat) {
    if (lat === 0) return 59;
    if (Math.abs(lat) === 87) return 2;
    if (Math.abs(lat) > 87) return 1;
    
    const nz = 15;
    const a = 1 - Math.cos(Math.PI / (2 * nz));
    const b = Math.cos(Math.PI / 180.0 * Math.abs(lat));
    
    if (b * b <= a) return 1;
    
    const nl = 2 * Math.PI / Math.acos(1 - a / (b * b));
    return Math.floor(nl);
  }
}

class EnhancedCPRAircraftTracker {
  constructor() {
    this.aircraftStates = new Map();
    this.frameTimeout = 10000;
    this.stats = {
      positionMessages: 0,
      evenFrames: 0,
      oddFrames: 0,
      localDecodes: 0,
      globalDecodes: 0,
      failedDecodes: 0,
      invalidPositions: 0,
      lowNicKept: 0  // NEW: Track low NIC preserved records
    };
    
    setInterval(() => this.cleanup(), 30000);
    setInterval(() => this.logStats(), 30000);
  }
  
  processPositionMessage(icao, message, timestamp) {
    const cprData = ModeS.extractCPRData(message);
    if (!cprData) return null;
    
    // Get NIC value for this message
    const nic = ModeS.nic(message);
    
    this.stats.positionMessages++;
    if (cprData.format === 'even') {
      this.stats.evenFrames++;
    } else {
      this.stats.oddFrames++;
    }
    
    if (!this.aircraftStates.has(icao)) {
      this.aircraftStates.set(icao, {
        cprFrames: {},
        lastPosition: null,
        lastSeen: timestamp,
        decodeAttempts: 0
      });
    }
    
    const aircraft = this.aircraftStates.get(icao);
    aircraft.lastSeen = timestamp;
    aircraft.decodeAttempts++;
    
    // Store the CPR frame
    aircraft.cprFrames[cprData.format] = {
      lat: cprData.lat,
      lon: cprData.lon,
      timestamp: cprData.timestamp
    };
    
    let position = null;
    
    // Try local decoding first (if we have a reference position)
    if (aircraft.lastPosition) {
      const localPos = ModeS.cprLocalDecode(
        aircraft.lastPosition.lat,
        aircraft.lastPosition.lon,
        cprData.lat,
        cprData.lon,
        cprData.format === 'odd'
      );
      
      if (localPos && this.isValidPosition(localPos)) {
        position = localPos;
        position.method = 'local';
        this.stats.localDecodes++;
      }
    }
    
    // Try global decoding if local failed and we have both frame types
    if (!position && aircraft.cprFrames.even && aircraft.cprFrames.odd) {
      const evenFrame = aircraft.cprFrames.even;
      const oddFrame = aircraft.cprFrames.odd;
      
      // Check if frames are recent enough to pair
      const timeDiff = Math.abs(evenFrame.timestamp - oddFrame.timestamp);
      if (timeDiff < this.frameTimeout) {
        const globalPos = ModeS.cprGlobalDecode(evenFrame, oddFrame);
        
        if (globalPos && this.isValidPosition(globalPos)) {
          position = globalPos;
          position.method = 'global';
          this.stats.globalDecodes++;
        } else {
          this.stats.failedDecodes++;
        }
      }
    }
    
    // Update aircraft state if we got a valid position
    if (position) {
      aircraft.lastPosition = {
        lat: position.lat,
        lon: position.lon,
        timestamp: timestamp,
        method: position.method
      };
      
      return {
        lat: position.lat,
        lon: position.lon,
        method: position.method,
        nic: nic
      };
    } else {
      // CPR FAILED - Check if we should keep this record due to low NIC
      if (nic !== null && nic < 7) {
        this.stats.lowNicKept++;
        return {
          lat: null,  // Will be converted to empty string in output
          lon: null,  // Will be converted to empty string in output
          method: 'low_nic_preserved',
          nic: nic,
          cprFailed: true
        };
      }
      
      if (aircraft.decodeAttempts > 1) {
        this.stats.failedDecodes++;
      }
    }
    
    return null;
  }
  
  isValidPosition(pos) {
    const valid = pos && 
           pos.lat >= -90 && pos.lat <= 90 &&
           pos.lon >= -180 && pos.lon <= 180 &&
           !isNaN(pos.lat) && !isNaN(pos.lon) &&
           Math.abs(pos.lat) > 0.001 && Math.abs(pos.lon) > 0.001; // Not null island
    
    if (!valid) {
      this.stats.invalidPositions++;
    }
    
    return valid;
  }
  
  logStats() {
    console.log(`CPR Stats: ${this.stats.positionMessages} pos msgs | E:${this.stats.evenFrames} O:${this.stats.oddFrames} | Local:${this.stats.localDecodes} Global:${this.stats.globalDecodes} | Failed:${this.stats.failedDecodes} | LowNIC:${this.stats.lowNicKept}`);
  }
  
  cleanup() {
    const now = Date.now();
    const timeout = 300000; // 5 minutes
    
    for (const [icao, aircraft] of this.aircraftStates.entries()) {
      if (now - aircraft.lastSeen > timeout) {
        this.aircraftStates.delete(icao);
      } else {
        // Clean old CPR frames
        if (aircraft.cprFrames.even && now - aircraft.cprFrames.even.timestamp > this.frameTimeout) {
          delete aircraft.cprFrames.even;
        }
        if (aircraft.cprFrames.odd && now - aircraft.cprFrames.odd.timestamp > this.frameTimeout) {
          delete aircraft.cprFrames.odd;
        }
      }
    }
  }
  
  getStats() {
    return this.stats;
  }
}

class S3Uploader {
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.bucket = config.bucket;
    this.region = config.region || 'us-east-1';
    this.uploadLatest = config.uploadLatest !== false; // Default true
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelay = config.retryDelay || 1000;
    
    if (this.enabled && !this.bucket) {
      throw new Error('S3 bucket name is required when S3 upload is enabled');
    }
    
    if (this.enabled) {
      this.s3Client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      });
      
      console.log(`S3 uploader initialized: bucket=${this.bucket}, region=${this.region}`);
      console.log(`S3 credentials check: AccessKeyId=${process.env.AWS_ACCESS_KEY_ID ? 'SET' : 'NOT SET'}, SecretAccessKey=${process.env.AWS_SECRET_ACCESS_KEY ? 'SET' : 'NOT SET'}`);
    } else {
      console.log('S3 uploader disabled (S3_UPLOAD_ENABLED not set to true)');
    }
  }
  
  async uploadFile(localPath, s3Key, contentType = 'application/json') {
    if (!this.enabled) {
      console.log('S3 upload skipped - S3 uploader not enabled');
      return false;
    }
    
    try {
      // Check if file exists before attempting upload
      if (!fs.existsSync(localPath)) {
        console.error(`S3 upload failed for ${s3Key}: Local file does not exist: ${localPath}`);
        return false;
      }
      
      const fileContent = fs.readFileSync(localPath);
      
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: fileContent,
        ContentType: contentType,
        CacheControl: 'no-cache, max-age=0'
      });
      
      const result = await this.s3Client.send(command);
      console.log(`S3 upload successful: ${s3Key}`);
      return true;
    } catch (error) {
      console.error(`S3 upload failed for ${s3Key}:`, error.message);
      if (error.name === 'CredentialsProviderError') {
        console.error('AWS credentials not found. Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.');
      }
      return false;
    }
  }
  
  async uploadWithRetry(localPath, s3Key, contentType = 'application/json') {
    if (!this.enabled) return false;
    
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      const success = await this.uploadFile(localPath, s3Key, contentType);
      if (success) {
        return true;
      }
      
      if (attempt < this.retryAttempts) {
        console.log(`S3 upload attempt ${attempt} failed for ${s3Key}, retrying in ${this.retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      }
    }
    
    console.error(`S3 upload failed for ${s3Key} after ${this.retryAttempts} attempts`);
    return false;
  }
  
  generateS3Key(filename) {
    const timestamp = new Date();
    const year = timestamp.getUTCFullYear();
    const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
    const day = String(timestamp.getUTCDate()).padStart(2, '0');
    const hour = String(timestamp.getUTCHours()).padStart(2, '0');
    
    return `${year}/${month}/${day}/${hour}/${filename}`;
  }
}

class EmailNotifier {
  constructor() {
    this.enabled = process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD && process.env.EMAIL_TO;
    this.emailUser = process.env.EMAIL_USER;
    this.emailPassword = process.env.EMAIL_APP_PASSWORD;
    this.emailTo = process.env.EMAIL_TO;
    this.isAlertSent = false;
    
    if (this.enabled) {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: this.emailUser,
          pass: this.emailPassword
        }
      });
      console.log(`Email notifications enabled: ${this.emailUser} -> ${this.emailTo}`);
    } else {
      console.log('Email notifications disabled (missing EMAIL_USER, EMAIL_APP_PASSWORD, or EMAIL_TO)');
    }
  }
  
  async sendAlert(subject, message) {
    if (!this.enabled || this.isAlertSent) return;
    
    try {
      await this.transporter.sendMail({
        from: this.emailUser,
        to: this.emailTo,
        subject: `ADSB Alert: ${subject}`,
        text: message,
        html: `<div style="font-family: Arial, sans-serif;"><h3>ADSB System Alert</h3><p><strong>${subject}</strong></p><p>${message}</p><p><em>Timestamp: ${new Date().toISOString()}</em></p></div>`
      });
      
      this.isAlertSent = true;
      console.log(`Alert email sent: ${subject}`);
    } catch (error) {
      console.error('Failed to send email alert:', error.message);
    }
  }
  
  async sendRecovery(subject, message) {
    if (!this.enabled) {
      console.log('Email recovery skipped - notifications disabled');
      return;
    }
    
    if (!this.isAlertSent) {
      console.log('Email recovery skipped - no previous alert was sent');
      return;
    }
    
    try {
      await this.transporter.sendMail({
        from: this.emailUser,
        to: this.emailTo,
        subject: `ADSB Recovery: ${subject}`,
        text: message,
        html: `<div style="font-family: Arial, sans-serif;"><h3>ADSB System Recovery</h3><p><strong>${subject}</strong></p><p>${message}</p><p><em>Timestamp: ${new Date().toISOString()}</em></p></div>`
      });
      
      this.isAlertSent = false; // Reset alert status after successful recovery email
      console.log(`Recovery email sent: ${subject}`);
    } catch (error) {
      console.error('Failed to send recovery email:', error.message);
    }
  }
}

class SimplifiedBeastProcessor {
constructor() {
  this.host = 'readsb';  // Changed from 'out.adsb.lol'
  this.port = 30901;        // Changed from 1337 (standard beast port)
  this.aircraftDB = new Map();
  this.cprTracker = new EnhancedCPRAircraftTracker();
  this.outputDir = './output';
  this.buffer = Buffer.alloc(0);
  this.h3Resolution = 8;
  this.startTime = Date.now();
  
  // Data monitoring for email alerts
  this.lastDataReceived = Date.now();
  this.emailNotifier = new EmailNotifier();
  this.dataTimeoutMs = 60000; // 1 minute
  
  // Initialize S3 uploader
  this.s3Uploader = new S3Uploader({
    enabled: process.env.S3_UPLOAD_ENABLED === 'true',
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || 'ap-southeast-1',
    uploadLatest: process.env.S3_UPLOAD_LATEST !== 'false',
    retryAttempts: parseInt(process.env.S3_RETRY_ATTEMPTS) || 3,
    retryDelay: parseInt(process.env.S3_RETRY_DELAY) || 1000
  });
  
  if (!fs.existsSync(this.outputDir)) {
    fs.mkdirSync(this.outputDir, { recursive: true });
  }
  
  // Start monitoring for data timeout
  this.startDataMonitoring();
}
  
  decodeBeastMessage(data) {
    if (data.length < 2 || data[0] !== 0x1A) return null;
    
    const msgType = data[1];
    
    // Beast message format:
    // 0x1A <type> <6-byte timestamp> <1-byte signal> <message>
    // Total minimum length = 1 + 1 + 6 + 1 + message_length
    
    let messageLength;
    let totalLength;
    
    if (msgType === 0x31) {
      messageLength = 7;   // Short Mode S message (56 bits = 7 bytes)
      totalLength = 1 + 1 + 6 + 1 + 7; // = 16 bytes
    } else if (msgType === 0x32) {
      messageLength = 14;  // Long Mode S message (112 bits = 14 bytes)  
      totalLength = 1 + 1 + 6 + 1 + 14; // = 23 bytes
    } else if (msgType === 0x33) {
      messageLength = 14;  // Extended squitter (112 bits = 14 bytes)
      totalLength = 1 + 1 + 6 + 1 + 14; // = 23 bytes
    } else {
      // Unknown message type, skip
      return null;
    }
    
    if (data.length < totalLength) {
      return null;
    }
    
    // Extract timestamp (6 bytes starting at offset 2)
    const timestampBytes = data.slice(2, 8);
    let timestamp = 0;
    for (let i = 0; i < 6; i++) {
      timestamp = (timestamp << 8) | timestampBytes[i];
    }
    
    // Skip signal strength byte at offset 8
    // Message starts at offset 9
    const message = data.slice(9, 9 + messageLength);
    
    const timestampMs = timestamp / 12000.0;
    const utcTimestamp = new Date(this.startTime + timestampMs).toISOString();
    
    return {
      timestamp: utcTimestamp,
      message: message,
      msgType: msgType
    };
  }
  
  decodeModeSFields(message, utcTimestamp, msgType) {
    const icao = ModeS.icao(message);
    const typecode = ModeS.typecode(message);
    
    if (!icao) return null;
    
    // Fixed CRC check
    const crcValid = ModeS.crc24(message) === 0;
    if (!crcValid) return null;
    
    const fields = {
      hex: icao,
      timestamp: utcTimestamp
    };
    
    // Position messages (TC 9-18)
    if (typecode >= 9 && typecode <= 18) {
      const nic = ModeS.nic(message);
      if (nic !== null) fields.nic = nic;
      
      // Extract altitude
      const alt_baro = ModeS.alt_baro(message);
      if (alt_baro !== null) fields.alt_baro = alt_baro;
      
      const position = this.cprTracker.processPositionMessage(icao, message, Date.now());
      if (position) {
        if (position.cprFailed) {
          // CPR failed but NIC < 7, preserve with empty strings
          fields.lat = "";      // Empty string instead of null
          fields.lon = "";      // Empty string instead of null
        } else {
          // Normal successful position decode
          fields.lat = position.lat;
          fields.lon = position.lon;
          
        }
      }
    }
    
    // Velocity messages (TC 19)
    if (typecode === 19) {
      const velocity = ModeS.velocity(message);
      if (velocity) {
        if (velocity.gs !== null) fields.gs = velocity.gs;
        if (velocity.track !== null) fields.track = velocity.track;
        if (velocity.vertical_rate !== null) fields.vertical_rate = velocity.vertical_rate;
      }
    }
    
    // Aircraft identification (TC 1-4)
    if (typecode >= 1 && typecode <= 4) {
      const callsign = ModeS.callsign(message);
      if (callsign) {
        fields.flight = callsign;
      }
    }
    
    return fields;
  }
  
  processBeastStream() {
    const client = new net.Socket();
    let totalBytesReceived = 0;
    let dataEvents = 0;
    
    console.log(`Attempting to connect to ${this.host}:${this.port} (BEAST feed)...`);
    
    client.connect(this.port, this.host, () => {
      console.log(`✓ Connected to BEAST stream at ${this.host}:${this.port} - Enhanced CPR with low NIC preservation`);
      
      // Set timeout to detect if no data comes through
      setTimeout(() => {
        if (totalBytesReceived === 0) {
          console.log(`❌ No data received after 30 seconds - may need active feeder status`);
        }
      }, 30000);
    });
    
    client.on('data', (data) => {
      dataEvents++;
      totalBytesReceived += data.length;
      
      // Log every data event for the first 10 events, then every 10 seconds
      if (dataEvents <= 10 || dataEvents % 100 === 0) {
        console.log(`📊 Data event #${dataEvents}: ${data.length} bytes, total: ${totalBytesReceived}, sample: ${data.slice(0, 8).toString('hex')}`);
      }
      
      this.buffer = Buffer.concat([this.buffer, data]);
      this.processBuffer();
    });
    
    client.on('close', () => {
      console.log(`✗ Connection to ${this.host}:${this.port} closed (received ${totalBytesReceived} bytes total), reconnecting in 5 seconds...`);
      setTimeout(() => this.processBeastStream(), 5000);
    });
    
    client.on('error', (err) => {
      console.error(`✗ Connection error to ${this.host}:${this.port}:`, err.message);
      setTimeout(() => this.processBeastStream(), 5000);
    });
  }
  
  processBuffer() {
    while (this.buffer.length >= 2) {
      const syncPos = this.buffer.indexOf(0x1A);
      if (syncPos === -1) {
        this.buffer = this.buffer.slice(-1);
        break;
      }
      
      if (syncPos > 0) {
        this.buffer = this.buffer.slice(syncPos);
      }
      
      if (this.buffer.length < 2) break;
      
      const msgType = this.buffer[1];
      
      let msgLen;
      if (msgType === 0x31) {
        msgLen = 16; // 1+1+6+1+7
      } else if (msgType === 0x32) {
        msgLen = 23; // 1+1+6+1+14  
      } else if (msgType === 0x33) {
        msgLen = 23; // 1+1+6+1+14
      } else {
        // Unknown type, skip this byte and continue
        this.buffer = this.buffer.slice(1);
        continue;
      }
      
      if (this.buffer.length < msgLen) break;
      
      const beastMsg = this.decodeBeastMessage(this.buffer.slice(0, msgLen));
      if (beastMsg) {
        const fields = this.decodeModeSFields(beastMsg.message, beastMsg.timestamp, beastMsg.msgType);
        if (fields) {
          this.updateAircraftDB(fields);
        }
      }
      
      this.buffer = this.buffer.slice(msgLen);
    }
  }
  
  updateAircraftDB(fields) {
    const icao = fields.hex;
    const now = Date.now();
    
    // Only update this when we actually process real aircraft data
    this.lastDataReceived = now;
    
    if (!this.aircraftDB.has(icao)) {
      this.aircraftDB.set(icao, {
        hex: icao
      });
    }
    
    const aircraft = this.aircraftDB.get(icao);
    Object.assign(aircraft, fields);
    aircraft.last_seen = now;
  }
  
  startDataMonitoring() {
    console.log('Starting data monitoring - will alert if no data for 60 seconds');
    
    setInterval(async () => {
      const now = Date.now();
      const timeSinceLastData = now - this.lastDataReceived;
      
      if (timeSinceLastData > this.dataTimeoutMs) {
        // No data for more than 1 minute
        if (!this.emailNotifier.isAlertSent) {
          console.log(`No data for ${Math.round(timeSinceLastData / 1000)}s - sending alert email`);
          await this.emailNotifier.sendAlert(
            'No Data Received',
            `ADSB beast processor has not received any data for ${Math.round(timeSinceLastData / 1000)} seconds. Last data received at ${new Date(this.lastDataReceived).toISOString()}.`
          );
        }
      } else {
        // Data is flowing normally - send recovery if we previously sent an alert
        if (this.emailNotifier.isAlertSent) {
          console.log(`Data flow restored (${Math.round(timeSinceLastData / 1000)}s since last data) - sending recovery email`);
          await this.emailNotifier.sendRecovery(
            'Data Flow Restored',
            `ADSB beast processor has resumed receiving data. System recovered and data flow is now normal. Most recent data received ${Math.round(timeSinceLastData / 1000)} seconds ago.`
          );
        }
      }
    }, 15000); // Check every 15 seconds for faster recovery detection
  }

// Most concise approach
roundToNearest5Seconds(timestamp) {
  const d = new Date(timestamp);
  d.setSeconds(Math.floor(d.getSeconds() / 5) * 5, 0);
  return d;
};
  
generateJSONFiles() {
  setInterval(async () => {
    try {
      const cutoff = Date.now() - 60000;
      
      // Clean old aircraft
      for (const [icao, aircraft] of this.aircraftDB.entries()) {
        if (aircraft.last_seen < cutoff) {
          this.aircraftDB.delete(icao);
        }
      }
      
      const aircraftArray = Array.from(this.aircraftDB.values()).map(aircraft => {
        const simplified = {
          hex: aircraft.hex,
        };
        
        simplified.nic = aircraft?.nic || 0;
        simplified.flight = aircraft?.flight || "";
        
        simplified.lat = aircraft?.lat || ""; // Can be number or empty string
        simplified.lon = aircraft?.lon || ""; // Can be number or empty string
        
        simplified.alt_baro = aircraft?.alt_baro || "";
        simplified.gs = aircraft?.gs || "";
        simplified.track = aircraft?.track || "";
        simplified.vertical_rate = aircraft?.vertical_rate || "";
        
        return simplified;
      });
      
      const timestamp = this.roundToNearest5Seconds(new Date());

      const outputData = {
        now: timestamp.toISOString(),
        messages: aircraftArray?.length || 0,
        aircraft: aircraftArray
      };
      
      const filename = `aircraft_${timestamp.toISOString().replace(/[:.]/g, '_').slice(0, -5)}.json`;
      const filepath = path.join(this.outputDir, filename);
      const latestPath = path.join(this.outputDir, 'latest.json');
      
      // Write files locally
      fs.writeFileSync(filepath, JSON.stringify(outputData, null, 2));
      fs.writeFileSync(latestPath, JSON.stringify(outputData, null, 2));
      
      // Upload to S3 if enabled and we have aircraft data
      if (this.s3Uploader.enabled && aircraftArray.length > 0) {
        // Upload timestamped file
        const s3Key = this.s3Uploader.generateS3Key(filename);
        this.s3Uploader.uploadWithRetry(filepath, s3Key).catch(error => {
          console.error(`Background S3 upload failed for ${filename}:`, error);
        });
        
        // Upload latest file if configured (disabled)
        // if (this.s3Uploader.uploadLatest) {
        //   this.s3Uploader.uploadWithRetry(latestPath, 'latest.json').catch(error => {
        //     console.error(`Background S3 upload failed for latest.json:`, error);
        //   });
        // }
      } else if (this.s3Uploader.enabled && aircraftArray.length === 0) {
        console.log(`S3 upload skipped: 0 aircraft detected (upstream likely dead)`);
      }
      
      const withPos = aircraftArray.filter(a => a.lat && a.lon && a.lat !== "").length;
      const withEmptyPos = aircraftArray.filter(a => a.lat === "" && a.lon === "").length;
      const stats = this.cprTracker.getStats();
      
      const s3Status = this.s3Uploader.enabled ? ' | S3: enabled' : '';
      console.log(`${aircraftArray.length} aircraft (${withPos} with position, ${withEmptyPos} low NIC preserved) | CPR Success Rate: ${((stats.localDecodes + stats.globalDecodes) / Math.max(stats.positionMessages, 1) * 100).toFixed(1)}%${s3Status}`);
      
    } catch (error) {
      console.error('JSON generation error:', error);
    }
  }, 5000);
}
  
  start() {
    this.processBeastStream();
    this.generateJSONFiles();
  }
}

const processor = new SimplifiedBeastProcessor();

if (process.env.H3_RESOLUTION) {
  processor.h3Resolution = parseInt(process.env.H3_RESOLUTION);
}

processor.start();


// Start the cleanup interval (every 10 minutes)
const cleanupInterval = setInterval(cleanupOldFiles, 10 * 60 * 1000);

// Optional: Run cleanup immediately on startup
cleanupOldFiles();

process.on('SIGINT', () => {
    console.log('Shutting down...');
    clearInterval(cleanupInterval);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    clearInterval(cleanupInterval);
    process.exit(0);
});