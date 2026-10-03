import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const CONFIG = {
  port: parseInt(process.env.PORT || '8888', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  invitationCode: process.env.INVITATION_CODE || process.env.SITE_PASSWORD || 'tt8888',
  sitePassword: process.env.INVITATION_CODE || process.env.SITE_PASSWORD || 'tt8888', // Backwards compatibility
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  staticDir: path.resolve(process.cwd(), 'dist/client'),
};
