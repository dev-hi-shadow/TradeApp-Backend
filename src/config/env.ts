import dotenv from 'dotenv';
dotenv.config();

export const env = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/paper_trading',
  JWT_SECRET: process.env.JWT_SECRET || 'dev_secret_change_me',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  PRICE_TICK_MS: parseInt(process.env.PRICE_TICK_MS || '2000', 10),
  DEFAULT_BALANCE: parseFloat(process.env.DEFAULT_BALANCE || '100000'),
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',
  ANGEL_KEY: process.env.ANGEL_KEY || '',
  ANGEL_CLIENT_CODE: process.env.ANGEL_CLIENT_CODE || '',
  ANGEL_PASSWORD: process.env.ANGEL_PASSWORD || '',
  ANGEL_TOTP: process.env.ANGEL_TOTP || '',
};

export const angelEnabled = !!(env.ANGEL_KEY && env.ANGEL_CLIENT_CODE && env.ANGEL_PASSWORD && env.ANGEL_TOTP);
