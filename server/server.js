const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const path = require('path');
const mysqlPool = require('./config/database.js');
const nodeFetch = require('node-fetch');
const expressWs = require('express-ws');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');

// Load environment variables
const envPath = process.env.NODE_ENV === 'production'
  ? path.resolve(__dirname, '.env')
  : path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

// Import services (STATIC classes)
const { ApiKeyService } = require('./services/apiKeyService.js');
const { ExternalApiService } = require('./services/externalApiService.js');
const { PhoneNumberService } = require('./services/phoneNumberService.js');
const AgentService = require('./services/agentService.js');
const { CampaignService } = require('./services/campaignService.js');
const { AuthService } = require('./services/authService.js');
const TwilioService = require('./services/twilioService.js');
const { TwilioBasicService } = require('./services/twilioBasicService.js');
const { MediaStreamHandler } = require('./services/mediaStreamHandler.js');
const { ElevenLabsStreamHandler } = require('./services/elevenLabsStreamHandler.js');
const AdminService = require('./services/adminService.js');

// Init server
const app = express();
const PORT = Number(process.env.PORT) || 5000;
expressWs(app);

// Instantiate ONLY services that require instances
const campaignService = new CampaignService(mysqlPool);
const authService = new AuthService(mysqlPool);
const twilioService = new TwilioService();
const twilioBasicService = new TwilioBasicService();
const adminService = new AdminService(mysqlPool);
// Initialize MediaStreamHandler for voice call pipeline
let mediaStreamHandler = null;

if (process.env.DEEPGRAM_API_KEY && process.env.GOOGLE_GEMINI_API_KEY) {
  mediaStreamHandler = new MediaStreamHandler(
    process.env.DEEPGRAM_API_KEY,
    process.env.GOOGLE_GEMINI_API_KEY,
    campaignService
  );
  console.log("MediaStreamHandler initialized with Deepgram + Gemini");
} else {
  console.warn("Voice call feature disabled — missing DEEPGRAM_API_KEY or GOOGLE_GEMINI_API_KEY");
}

const agentService = new AgentService(mysqlPool);

// === ADD THIS BLOCK ===
if (!process.env.ELEVEN_LABS_API_KEY) {
  console.warn("WARNING: ELEVEN_LABS_API_KEY is not configured. Text-to-speech will not work.");
} else {
  console.log("ElevenLabs API key loaded successfully");
}
// =======================

console.log("Twilio Basic Service initialized");


// ================= CORS ==================
const FRONTEND_URL = "https://benevolent-custard-76836b.netlify.app";

const corsOptions = {
  origin: [
    FRONTEND_URL,
    /\.netlify\.app$/
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ------------------------------------------------
 // For Twilio webhook form data

// Health check endpoint for Railway
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// API Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Authentication endpoints
// User login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await authService.authenticateUser(email, password);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// User registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      return res.status(400).json({ success: false, message: 'Email, username, and password are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    // Username validation (alphanumeric, 3-20 characters)
    const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({ success: false, message: 'Username must be 3-20 alphanumeric characters' });
    }

    // Password strength validation (at least 6 characters)
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long' });
    }

    const user = await authService.registerUser(email, username, password);
    res.json({ success: true, user });
  } catch (error) {
    console.error('Registration error:', error);
    if (error.message === 'User already exists') {
      return res.status(409).json({ success: false, message: 'User with this email or username already exists' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== ADMIN PANEL ENDPOINTS ====================

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const admin = await adminService.login(email, password);
    await adminService.logActivity(admin.id, 'admin_login', null, 'Admin logged in', req.ip);
    
    res.json({ success: true, admin });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// Get dashboard statistics
app.get('/api/admin/stats', async (req, res) => {
  try {
    const stats = await adminService.getDashboardStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all users with pagination and search
app.get('/api/admin/users', async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const search = req.query.search || '';
    
    const result = await adminService.getAllUsers(page, limit, search);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get detailed user information
app.get('/api/admin/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userDetails = await adminService.getUserDetails(userId);
    res.json({ success: true, ...userDetails });
  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Set service limit for a user
app.post('/api/admin/users/:userId/limits', async (req, res) => {
  try {
    const { userId } = req.params;
    const { serviceName, monthlyLimit, dailyLimit, isEnabled, adminId } = req.body;
    
    if (!serviceName || !['elevenlabs', 'gemini', 'deepgram'].includes(serviceName)) {
      return res.status(400).json({ success: false, message: 'Invalid service name' });
    }

    const result = await adminService.setServiceLimit(
      userId, 
      serviceName, 
      monthlyLimit, 
      dailyLimit, 
      isEnabled
    );

    await adminService.logActivity(
      adminId, 
      'set_service_limit', 
      userId, 
      `Set ${serviceName} limit: monthly=${monthlyLimit}, daily=${dailyLimit}`, 
      req.ip
    );

    res.json(result);
  } catch (error) {
    console.error('Error setting service limit:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get service limits for a user
app.get('/api/admin/users/:userId/limits', async (req, res) => {
  try {
    const { userId } = req.params;
    const limits = await adminService.getUserServiceLimits(userId);
    res.json({ success: true, limits });
  } catch (error) {
    console.error('Error fetching service limits:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create billing record
app.post('/api/admin/billing', async (req, res) => {
  try {
    const { userId, periodStart, periodEnd, usageData, platformFee, adminId } = req.body;
    
    const result = await adminService.createBillingRecord(
      userId, 
      periodStart, 
      periodEnd, 
      usageData, 
      platformFee
    );

    await adminService.logActivity(
      adminId, 
      'create_billing', 
      userId, 
      `Created billing record for period ${periodStart} to ${periodEnd}`, 
      req.ip
    );

    res.json(result);
  } catch (error) {
    console.error('Error creating billing record:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update billing status
app.patch('/api/admin/billing/:billingId', async (req, res) => {
  try {
    const { billingId } = req.params;
    const { status, notes, adminId } = req.body;
    
    if (!['pending', 'paid', 'overdue', 'cancelled'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid billing status' });
    }

    const result = await adminService.updateBillingStatus(billingId, status, notes);

    await adminService.logActivity(
      adminId, 
      'update_billing_status', 
      null, 
      `Updated billing ${billingId} status to ${status}`, 
      req.ip
    );

    res.json(result);
  } catch (error) {
    console.error('Error updating billing status:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== END ADMIN PANEL ENDPOINTS ====================

// Get all API keys for a user (metadata only)
app.get('/api/user-api-keys/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const apiKeys = await ApiKeyService.getUserApiKeysMetadata(userId);
    res.json({ success: true, apiKeys });
  } catch (error) {
    console.error('Error fetching user API keys:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get a specific API key for a user and service
app.get('/api/user-api-keys/:userId/:serviceName', async (req, res) => {
  try {
    const { userId, serviceName } = req.params;
    const apiKey = await ApiKeyService.getUserApiKey(userId, serviceName);
    if (!apiKey) {
      return res.status(404).json({ success: false, message: 'API key not found' });
    }

    const maskedKey = apiKey.substring(0, 4) + '*'.repeat(Math.max(0, apiKey.length - 4));
    res.json({ success: true, apiKey: maskedKey });
  } catch (error) {
    console.error('Error fetching user API key:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Save or update an API key for a user
app.post('/api/user-api-keys', async (req, res) => {
  try {
    const { userId, serviceName, apiKey } = req.body;
    if (!userId || !serviceName || !apiKey) {
      return res.status(400).json({ success: false, message: 'User ID, service name, and API key are required' });
    }

    await ApiKeyService.saveUserApiKey(userId, serviceName, apiKey);
    res.json({ success: true, message: 'API key saved successfully' });
  } catch (error) {
    console.error('Error saving user API key:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete an API key for a user and service
app.delete('/api/user-api-keys/:userId/:serviceName', async (req, res) => {
  try {
    const { userId, serviceName } = req.params;
    await ApiKeyService.deleteUserApiKey(userId, serviceName);
    res.json({ success: true, message: 'API key deleted successfully' });
  } catch (error) {
    console.error('Error deleting user API key:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Validate an API key
app.post('/api/validate-api-key', async (req, res) => {
  try {
    const { userId, serviceName, apiKey } = req.body;
    if (!userId || !serviceName || !apiKey) {
      return res.status(400).json({ success: false, message: 'User ID, service name, and API key are required' });
    }

    const isValid = await ApiKeyService.validateApiKey(userId, serviceName, apiKey);
    res.json({ success: true, valid: isValid });
  } catch (error) {
    console.error('Error validating API key:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ElevenLabs voices endpoint - fetch all voices from ElevenLabs API
app.get('/api/voices/elevenlabs', async (req, res) => {
  try {
    // Get ElevenLabs API key from environment variables
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      console.error('ElevenLabs API key not configured on server');
      return res.status(500).json({ success: false, message: 'ElevenLabs API key not configured on server' });
    }

    console.log('Fetching voices from ElevenLabs API with key:', apiKey.substring(0, 4) + '...');

    // Fetch voices from ElevenLabs API
    const response = await nodeFetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': apiKey
      }
    });

    console.log('ElevenLabs API response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs API error:', response.status, errorText);
      
      // Check if the response is HTML (error page)
      if (errorText.startsWith('<!DOCTYPE') || errorText.includes('<html')) {
        return res.status(500).json({ 
          success: false, 
          message: 'ElevenLabs API returned an HTML error page. Check API key and network connectivity.' 
        });
      }
      
      return res.status(response.status).json({ 
        success: false, 
        message: `ElevenLabs API error: ${response.statusText} - ${errorText}` 
      });
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const errorText = await response.text();
      console.error('ElevenLabs API returned non-JSON response:', errorText.substring(0, 200));
      return res.status(500).json({ 
        success: false, 
        message: 'ElevenLabs API returned invalid response format. Expected JSON.' 
      });
    }

    const data = await response.json();
    
    // Return voices with full metadata
    res.json({ 
      success: true, 
      voices: data.voices 
    });
  } catch (error) {
    console.error('Error fetching ElevenLabs voices:', error);
    res.status(500).json({ success: false, message: `Error fetching ElevenLabs voices: ${error.message}` });
  }
});
// Fetch ElevenLabs credits
app.get('/api/credits/elevenlabs/:userId', async (req, res) => {
  try {
    // Use shared ElevenLabs API key from environment
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return res.status(404).json({ success: false, message: 'ElevenLabs API key not configured' });
    }

    const response = await nodeFetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: {
        'xi-api-key': apiKey
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`ElevenLabs API error: ${response.status} - ${response.statusText}`, errorText);
      return res.status(response.status).json({ success: false, message: `ElevenLabs API error: ${response.statusText}` });
    }

    const data = await response.json();
    const credits = data.character_count || 0;
    res.json({ success: true, credits });
  } catch (error) {
    console.error('Error fetching ElevenLabs credits:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Fetch Google Gemini credits
app.get('/api/credits/gemini/:userId', async (req, res) => {
  try {
    const geminiApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(404).json({ success: false, message: 'Google Gemini API key not configured' });
    }

    const response = await nodeFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini API error: ${response.status} - ${response.statusText}`, errorText);
      return res.status(response.status).json({ success: false, message: `Gemini API error: ${response.statusText}` });
    }

    const data = await response.json();
    const modelCount = data.models && data.models.length > 0 ? data.models.length : 0;
    res.json({ success: true, credits: modelCount });
  } catch (error) {
    console.error('Error fetching Google Gemini credits:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Fetch Deepgram credits
app.get('/api/credits/deepgram/:userId', async (req, res) => {
  try {
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    if (!deepgramApiKey) {
      return res.status(400).json({ success: false, message: 'Deepgram API key not configured' });
    }

    // First, get the project ID associated with this API key
    const projectsResponse = await nodeFetch('https://api.deepgram.com/v1/projects', {
      method: 'GET',
      headers: {
        'Authorization': `Token ${deepgramApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!projectsResponse.ok) {
      const errorText = await projectsResponse.text();
      console.error(`Deepgram API error (projects): ${projectsResponse.status} - ${projectsResponse.statusText}`, errorText);
      
      // Return 0 credits if API key is invalid or endpoint returns error
      return res.json({ 
        success: true, 
        credits: 0,
        message: 'Deepgram API key may be invalid or expired'
      });
    }

    const projectsData = await projectsResponse.json();
    
    // Get the first project (usually there's only one)
    if (!projectsData.projects || projectsData.projects.length === 0) {
      return res.json({ 
        success: true, 
        credits: 0,
        message: 'No Deepgram projects found'
      });
    }

    const projectId = projectsData.projects[0].project_id;

    // Now fetch the balances for this project
    const balancesResponse = await nodeFetch(`https://api.deepgram.com/v1/projects/${projectId}/balances`, {
      method: 'GET',
      headers: {
        'Authorization': `Token ${deepgramApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!balancesResponse.ok) {
      const errorText = await balancesResponse.text();
      console.error(`Deepgram API error (balances): ${balancesResponse.status} - ${balancesResponse.statusText}`, errorText);
      
      return res.json({ 
        success: true, 
        credits: 0,
        message: 'Unable to fetch balance'
      });
    }

    const balancesData = await balancesResponse.json();
    
    // Sum all balances (usually just one)
    const totalBalance = balancesData.balances && balancesData.balances.length > 0
      ? balancesData.balances.reduce((sum, balance) => sum + (balance.amount || 0), 0)
      : 0;
    
    res.json({ success: true, credits: totalBalance });
  } catch (error) {
    console.error('Error fetching Deepgram credits:', error);
    // Return 0 on error instead of failing
    res.json({ success: true, credits: 0, message: 'Unable to fetch Deepgram credits' });
  }
});

// Get credit transactions for a user
app.get('/api/credits/transactions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const [transactions] = await mysqlPool.execute(
      'SELECT id, user_id, transaction_type, service_type, amount, description, created_at FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
      [userId]
    );

    res.json({
      success: true,
      transactions: transactions.map(t => ({
        id: t.id,
        userId: t.user_id,
        transactionType: t.transaction_type,
        serviceType: t.service_type,
        amount: t.amount,
        description: t.description,
        createdAt: t.created_at
      }))
    });
  } catch (error) {
    console.error('Error fetching credit transactions:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Phone number endpoints
// Get all phone numbers for a user
app.get('/api/phone-numbers', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const phoneNumbers = await PhoneNumberService.getPhoneNumbers(userId);
    res.json({ success: true, data: phoneNumbers });
  } catch (error) {
    console.error('Error fetching phone numbers:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get a specific phone number by ID
app.get('/api/phone-numbers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const phoneNumber = await PhoneNumberService.getPhoneNumberById(userId, id);
    if (!phoneNumber) {
      return res.status(404).json({ success: false, message: 'Phone number not found' });
    }

    res.json({ success: true, data: phoneNumber });
  } catch (error) {
    console.error('Error fetching phone number:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create a new phone number
app.post('/api/phone-numbers', async (req, res) => {
  try {
    const { userId, phoneNumber } = req.body;
    if (!userId || !phoneNumber) {
      return res.status(400).json({ success: false, message: 'User ID and phone number data are required' });
    }

    const newPhoneNumber = await PhoneNumberService.createPhoneNumber(userId, phoneNumber);
    res.json({ success: true, data: newPhoneNumber });
  } catch (error) {
    console.error('Error creating phone number:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update an existing phone number
app.put('/api/phone-numbers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, ...updateData } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    // Check if phone number exists and belongs to user first
    const existingPhoneNumber = await PhoneNumberService.getPhoneNumberById(userId, id);
    if (!existingPhoneNumber) {
      return res.status(404).json({ success: false, message: 'Phone number not found' });
    }

    const updatedPhoneNumber = await PhoneNumberService.updatePhoneNumber(userId, id, updateData);
    res.json({ success: true, data: updatedPhoneNumber });
  } catch (error) {
    console.error('Error updating phone number:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete a phone number
app.delete('/api/phone-numbers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    await PhoneNumberService.deletePhoneNumber(userId, id);
    res.json({ success: true, message: 'Phone number deleted successfully' });
  } catch (error) {
    console.error('Error deleting phone number:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Import a phone number
app.post('/api/phone-numbers/import', async (req, res) => {
  try {
    const { userId, phoneNumber } = req.body;
    if (!userId || !phoneNumber) {
      return res.status(400).json({ success: false, message: 'User ID and phone number data are required' });
    }

    const importedPhoneNumber = await PhoneNumberService.importPhoneNumber(userId, phoneNumber);
    res.json({ success: true, data: importedPhoneNumber });
  } catch (error) {
    console.error('Error importing phone number:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Twilio endpoints
// Validate Twilio credentials
app.post('/api/validate-twilio-credentials', async (req, res) => {
  try {
    const { accountSid, authToken } = req.body;
    if (!accountSid || !authToken) {
      return res.status(400).json({ success: false, message: 'Account SID and Auth Token are required' });
    }
    
    const client = twilio(accountSid, authToken);
    await client.api.accounts(accountSid).fetch();
    
    res.json({ success: true, message: 'Credentials are valid' });
  } catch (error) {
    console.error('Error validating Twilio credentials:', error);
    res.status(401).json({ success: false, message: 'Invalid Twilio credentials' });
  }
});

// Fetch available Twilio phone numbers
app.post('/api/fetch-twilio-numbers', async (req, res) => {
  try {
    const { accountSid, authToken } = req.body;
    if (!accountSid || !authToken) {
      return res.status(400).json({ success: false, message: 'Account SID and Auth Token are required' });
    }
    
    const client = twilio(accountSid, authToken);
    
    // Fetch all incoming phone numbers from Twilio account
    const incomingNumbers = await client.incomingPhoneNumbers.list({ limit: 100 });
    
    // Format the response
    const formattedNumbers = incomingNumbers.map(num => ({
      phoneNumber: num.phoneNumber,
      friendlyName: num.friendlyName,
      sid: num.sid,
      capabilities: {
        voice: num.capabilities?.voice || false,
        sms: num.capabilities?.sms || false,
        mms: num.capabilities?.mms || false
      }
    }));
    
    res.json({ success: true, data: formattedNumbers });
  } catch (error) {
    console.error('Error fetching Twilio numbers:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch phone numbers: ' + error.message });
  }
});

// Fetch phone numbers from user's Twilio account
app.post('/api/twilio/fetch-account-numbers', async (req, res) => {
  try {
    const { userId, accountSid } = req.body;
    if (!userId || !accountSid) {
      return res.status(400).json({ success: false, message: 'User ID and Account SID are required' });
    }
    
    const phoneNumbers = await twilioService.fetchPhoneNumbersFromUserAccount(userId, accountSid);
    
    res.json({ success: true, data: phoneNumbers });
  } catch (error) {
    console.error('Error fetching phone numbers from user account:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add phone number from user's Twilio account
app.post('/api/twilio/add-account-number', async (req, res) => {
  try {
    const { userId, accountSid, phoneNumber, region } = req.body;
    if (!userId || !accountSid || !phoneNumber || !region) {
      return res.status(400).json({ success: false, message: 'User ID, Account SID, phone number, and region are required' });
    }
    
    const result = await twilioService.addPhoneNumberFromAccount(userId, accountSid, phoneNumber, region);
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error adding phone number from account:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// Get Twilio calls for a user
app.get('/api/twilio/calls/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }
    
    // For now, return empty array - in production, fetch from database
    res.json({ success: true, data: [] });
  } catch (error) {
    console.error('Error fetching Twilio calls:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get Twilio phone numbers for a user
app.get('/api/twilio/phone-numbers/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }
    
    // For now, return empty array - in production, fetch from database
    res.json({ success: true, data: [] });
  } catch (error) {
    console.error('Error fetching Twilio phone numbers:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});


// Start a call endpoint (for frontend compatibility)
// Start a call endpoint (for frontend compatibility)
app.post('/call/start', async (req, res) => {
  try {
    const { userId, from, to, agentId } = req.body;

    if (!userId || !from || !to || !agentId) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Validate phone number formats
    if (!/^\+?[1-9]\d{1,14}$/.test(from)) {
      return res.status(400).json({ success: false, message: 'Invalid FROM number format' });
    }
    if (!/^\+?[1-9]\d{1,14}$/.test(to)) {
      return res.status(400).json({ success: false, message: 'Invalid TO number format' });
    }

    // Validate Twilio number belongs to user
    const userTwilioNumbers = await twilioService.getVerifiedNumbers(userId);
    const twilioNumber = userTwilioNumbers.find(num => num.id === from);

    if (!twilioNumber) {
      return res.status(400).json({
        success: false,
        message: 'From number must be a verified Twilio number for this user'
      });
    }

    // Generate call ID
    const callId = uuidv4();
    const database = mysqlPool;

    // Check if phone_number entry exists
    const [phoneRows] = await database.execute(
      'SELECT id FROM phone_numbers WHERE number = ? AND user_id = ?',
      [from, userId]
    );

    let phoneNumberId;
    if (phoneRows.length > 0) {
      phoneNumberId = phoneRows[0].id;
    } else {
      phoneNumberId = uuidv4();
      await database.execute(
        `INSERT INTO phone_numbers 
        (id, user_id, number, source, provider, created_at) 
        VALUES (?, ?, ?, 'twilio', 'twilio', NOW())`,
        [phoneNumberId, userId, from]
      );
    }

    // Insert call into DB
    await database.execute(
      `INSERT INTO calls 
      (id, phone_number_id, user_id, agent_id, from_number, to_number, status, twilio_number_id, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'initiated', ?, NOW())`,
      [callId, phoneNumberId, userId, agentId, from, to, twilioNumber.id]
    );

    // Prepare Twilio call
    const appUrl = process.env.APP_URL || `http://${process.env.SERVER_DOMAIN || 'localhost:5000'}`;
    const cleanAppUrl = appUrl.replace(/\/$/, '');

    const call = await twilioService.createCall({
      userId,
      twilioNumberId: twilioNumber.id,
      to,
      agentId,
      callId,
      appUrl: cleanAppUrl
    });

    // Save Twilio SID
    await database.execute(
      'UPDATE calls SET call_sid = ? WHERE id = ?',
      [call.sid, callId]
    );

    res.json({
      success: true,
      data: {
        callId,
        callSid: call.sid
      }
    });

  } catch (error) {
    console.error("Error starting call:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Make Twilio call
app.post('/api/twilio/make-call', async (req, res) => {
  try {
    const { userId, from, to, agentId } = req.body;
    
    if (!userId) {  
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }
    
    // Validate user ID format (UUID)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return res.status(400).json({ success: false, message: 'User ID must be a valid UUID' });
    }
    
    if (!from) {
      return res.status(400).json({ success: false, message: 'From number is required' });
    }
    
    if (!to) {
      return res.status(400).json({ success: false, message: 'To number is required' });
    }
    
    if (!agentId) {
      return res.status(400).json({ success: false, message: 'Agent ID is required' });
    }
    
    // Get all verified Twilio numbers for this user
    const userTwilioNumbers = await twilioService.getVerifiedNumbers(userId);
    
    // Find the Twilio number record by ID (from could be a UUID)
    let twilioNumber = userTwilioNumbers.find(num => num.id === from);
    
    // If not found by ID, try finding by phone number (in case from is already a phone number)
    if (!twilioNumber) {
      twilioNumber = userTwilioNumbers.find(num => num.number === from || num.phoneNumber === from);
    }
    
    if (!twilioNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'From number must be a verified Twilio number for this user' 
      });
    }
    
    // Extract the actual phone number from the twilioNumber object
    const fromPhoneNumber = twilioNumber.number || twilioNumber.phoneNumber;
    
    // Validate phone number formats
    if (!/^\+?[1-9]\d{1,14}$/.test(fromPhoneNumber)) {
      return res.status(400).json({ 
        success: false, 
        message: 'From number must be a valid Twilio number in E.164 format (e.g., +1234567890)' 
      });
    }
    
    if (!/^\+?[1-9]\d{1,14}$/.test(to)) {
      return res.status(400).json({ 
        success: false, 
        message: 'To number must be in E.164 format (e.g., +1234567890)' 
      });
    }
    
    // Generate a unique call ID
    const callId = require('uuid').v4();
    
    // Get app URL for callbacks
    const appUrl = process.env.APP_URL || `http://${process.env.SERVER_DOMAIN || 'localhost:5000'}`;
    const cleanAppUrl = appUrl.replace(/\/$/, '');
    
    // Create call record in database
    const database = require('./config/database.js').default;
    await database.execute(`INSERT INTO calls 
      (id, phone_number_id, user_id, agent_id, from_number, to_number, status, twilio_number_id, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'initiated', ?, NOW())`, 
      [callId, twilioNumber.id, userId, agentId, fromPhoneNumber, to, twilioNumber.id]);
    
    // Create the actual Twilio call using the ACTUAL PHONE NUMBER
    const call = await twilioService.createCall({
      userId: userId,
      twilioNumberId: twilioNumber.id,
      to: to,
      agentId: agentId,
      callId: callId,
      appUrl: cleanAppUrl,
      from: fromPhoneNumber  // ← ADD THIS: Pass the actual phone number
    });
    
    // Update call record with Twilio call SID
    await database.execute('UPDATE calls SET call_sid = ? WHERE id = ?', [call.sid, callId]);
    
    // Return success response with actual Twilio call SID
    res.json({ 
      success: true, 
      data: {
        id: callId,
        userId,
        callSid: call.sid,
        fromNumber: fromPhoneNumber,  // ← Return the actual phone number
        toNumber: to,
        agentId: agentId,
        direction: 'outbound',
        status: 'initiated',
        timestamp: new Date().toISOString(),
        duration: 0
      }
    });
    
  } catch (error) {
    console.error('Error making Twilio call:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add Twilio number
app.post('/api/add-twilio-number', async (req, res) => {
  try {
    const { userId, phoneNumber, region, accountSid, authToken } = req.body;
    if (!userId || !phoneNumber || !region || !accountSid || !authToken) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    
    // Use TwilioService to add the number and store in database
    const result = await twilioService.addTwilioNumber(
      userId,
      phoneNumber,
      region,
      accountSid,
      authToken
    );
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error adding Twilio number:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Twilio account management endpoints
// Get all Twilio accounts for a user
app.get('/api/twilio/accounts', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }
    
    const database = mysqlPool;
    const [rows] = await database.execute(
      'SELECT id, name, account_sid, auth_token, created_at FROM user_twilio_accounts WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    
    // Decrypt auth tokens before sending to frontend
    const accounts = rows.map(row => ({
      id: row.id,
      name: row.name,
      accountSid: row.account_sid,
      authToken: row.auth_token, // In a real implementation, you would decrypt this
      createdAt: row.created_at
    }));
    
    res.json({ success: true, data: accounts });
  } catch (error) {
    console.error('Error fetching Twilio accounts:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add a Twilio account for a user
app.post('/api/twilio/accounts', async (req, res) => {
  try {
    const { userId, name, accountSid, authToken } = req.body;
    if (!userId || !name || !accountSid || !authToken) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    
    const database = mysqlPool;
    const accountId = require('uuid').v4();
    
    // In a real implementation, you would encrypt the auth token before storing
    await database.execute(
      'INSERT INTO user_twilio_accounts (id, user_id, name, account_sid, auth_token, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [accountId, userId, name, accountSid, authToken]
    );
    
    res.json({ success: true, data: { id: accountId } });
  } catch (error) {
    console.error('Error adding Twilio account:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete a Twilio account
app.delete('/api/twilio/accounts/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }
    
    const database = mysqlPool;
    await database.execute(
      'DELETE FROM user_twilio_accounts WHERE id = ? AND user_id = ?',
      [accountId, userId]
    );
    
    res.json({ success: true, message: 'Account removed successfully' });
  } catch (error) {
    console.error('Error deleting Twilio account:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Agent endpoints
// Get all agents for a user
app.get('/api/agents', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Correct instance call
    const agents = await agentService.getAgents(userId);

    res.json({
      success: true,
      data: agents
    });
  } catch (error) {
    console.error('Error fetching agents:', error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get a specific agent by ID
app.get('/api/agents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const agent = await agentService.getAgentById(userId, id);
    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    res.json({ success: true, data: agent });
  } catch (error) {
    console.error('Error fetching agent:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create a new agent
app.post('/api/agents', async (req, res) => {
  try {
    const { userId, agent } = req.body;
    if (!userId || !agent) {
      return res.status(400).json({ success: false, message: 'User ID and agent data are required' });
    }

    const newAgent = await agentService.createAgent(userId, agent);
    res.json({ success: true, data: newAgent });
  } catch (error) {
    console.error('Error creating agent:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update an existing agent
app.put('/api/agents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    // Extract agent data (all properties except userId)
    const agentData = { ...req.body };
    delete agentData.userId;
    
    const updatedAgent = await agentService.updateAgent(userId, id, agentData);
    res.json({ success: true, data: updatedAgent });
  } catch (error) {
    console.error('Error updating agent:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete an agent
app.delete('/api/agents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    await agentService.deleteAgent(userId, id);
    res.json({ success: true, message: 'Agent deleted successfully' });
  } catch (error) {
    console.error('Error deleting agent:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Campaign endpoints
// Get all campaigns for a user
app.get('/api/campaigns', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const campaigns = await campaignService.getUserCampaigns(userId);
    res.json({ success: true, data: campaigns });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get a specific campaign by ID with records
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const campaignData = await campaignService.getCampaignWithRecords(id, userId);
    if (!campaignData) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    res.json({ success: true, data: campaignData });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create a new campaign
app.post('/api/campaigns', async (req, res) => {
  try {
    const { userId, name } = req.body;
    if (!userId || !name) {
      return res.status(400).json({ success: false, message: 'User ID and campaign name are required' });
    }

    const newCampaign = await campaignService.createCampaign(userId, name);
    res.json({ success: true, data: newCampaign });
  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update a campaign
app.put('/api/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, campaign } = req.body;
    if (!userId || !campaign) {
      return res.status(400).json({ success: false, message: 'User ID and campaign data are required' });
    }

    const updatedCampaign = await campaignService.updateCampaign(id, userId, campaign);
    res.json({ success: true, data: updatedCampaign });
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete a campaign
app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    await campaignService.deleteCampaign(id, userId);
    res.json({ success: true, message: 'Campaign deleted successfully' });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add phone numbers to a campaign
app.post('/api/campaigns/:id/phone-numbers', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, phoneNumbers } = req.body;
    if (!userId || !phoneNumbers) {
      return res.status(400).json({ success: false, message: 'User ID and phone numbers are required' });
    }

    await campaignService.addPhoneNumbersToCampaign(id, userId, phoneNumbers);
    res.json({ success: true, message: 'Phone numbers added to campaign successfully' });
  } catch (error) {
    console.error('Error adding phone numbers to campaign:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete a record from a campaign
app.delete('/api/campaigns/:campaignId/records/:recordId', async (req, res) => {
  try {
    const { campaignId, recordId } = req.params;
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const result = await campaignService.deleteRecord(recordId, campaignId, userId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Record not found or already deleted' });
    }

    res.json({ success: true, message: 'Record deleted successfully' });
  } catch (error) {
    console.error('Error deleting record:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Google Sheets endpoint for appending data
app.post('/api/tools/google-sheets/append', async (req, res) => {
  try {
    const { spreadsheetId, data, sheetName } = req.body;
    if (!spreadsheetId || !data) {
      return res.status(400).json({ success: false, message: 'Spreadsheet ID and data are required' });
    }

    // In a real implementation, you would use the Google Sheets API here
    // For now, we'll just log the data and return success
    console.log('Google Sheets append request:', { spreadsheetId, data, sheetName });
    
    res.json({ success: true, message: 'Data appended successfully' });
  } catch (error) {
    console.error('Error appending data to Google Sheets:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Voice preview endpoint
app.post('/api/voices/elevenlabs/preview', async (req, res) => {
  try {
    const { text, voiceId } = req.body;
    if (!text || !voiceId) {
      return res.status(400).json({ success: false, message: 'Text and voiceId are required' });
    }

    // For now, return a mock audio response (silent audio in base64)
    // In a real implementation, you would call ElevenLabs API here
    // This is a valid 1-second silent WAV audio file encoded in base64
    const silentAudioBase64 = 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAAAAA==';
    
    res.json({ 
      success: true, 
      audioData: silentAudioBase64,
      message: 'Voice preview generated successfully'
    });
  } catch (error) {
    console.error('Error generating voice preview:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// WebSocket endpoint for ElevenLabs STT
app.ws('/api/stt', function (ws, req) {
  elevenLabsStreamHandler.handleConnection(ws, req);
});
// WebSocket for Twilio → Deepgram → Gemini → ElevenLabs
app.ws('/api/call', (ws, req) => {
  if (!mediaStreamHandler) {
    ws.close();
    return;
  }
  mediaStreamHandler.handleConnection(ws, req);
});
// WebSocket endpoint for voice stream (frontend voice chat + Twilio calls)
app.ws('/voice-stream', function (ws, req) {
  console.log('New voice stream connection established');
  let audioChunksReceived = 0;
  const audioBuffer = [];
  let isProcessing = false; // Flag to prevent overlapping responses
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  const geminiApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY || process.env.VITE_ELEVEN_LABS_API_KEY;
  
  // Determine if this is a Twilio call or frontend chat
  const callId = req.query?.callId;
  const agentId = req.query?.agentId;
  const voiceId = req.query?.voiceId;
  const identity = req.query?.identity ? decodeURIComponent(req.query.identity) : null;
  const isTwilioCall = !!(callId && agentId);
  const isFrontendChat = !!(voiceId && !callId);
  
  console.log('Connection type:', isTwilioCall ? 'Twilio Call' : isFrontendChat ? 'Frontend Chat' : 'Unknown');
  console.log('Query params:', { voiceId, agentId, callId, identity: identity ? 'present' : 'missing' });
  console.log('Call ID:', callId);
  console.log('Agent ID:', agentId);
  
  // Map voice names to ElevenLabs voice IDs
  const voiceIdMap = {
    'eleven-rachel': '21m00Tcm4TlvDq8ikWAM',      // Rachel - Professional female
    'eleven-domi': 'AZnzlk1mvXvNF0XQwSqT',         // Domi - Warm male
    'eleven-bella': 'EXAVITQu4vr4xnSDxMaL',         // Bella - Bright female
    'eleven-antoni': 'ErXwobaYp0eMQ54XLiQy',        // Antoni - Deep male
    'eleven-elli': 'MF3mGyEYCHltNiPm4XZK',         // Elli - Expressive female
    'eleven-josh': 'TxGEqnHWrfWFTfGW9XjX',         // Josh - Strong male
    'eleven-arnold': 'VR6AewLVsFNTJdrC4xPG',       // Arnold - Deep US male
    'eleven-adam': 'pFZP5JQG7iQjIQuC4Hyc',        // Adam - Deep UK male
    'eleven-sam': 'yoZ06aMxZJJ28mfd3POQ'          // Sam - Conversational male
  };
  
  // Get agent voice ID from query params or use default
  let voiceIdentifier = voiceId || 'eleven-rachel';
  // Map the voice identifier to actual ElevenLabs voice ID
  let agentVoiceId = voiceIdMap[voiceIdentifier] || voiceIdentifier;
  // Initialize agent identity and name
  // For frontend chat, use identity from query params if provided
  let agentIdentity = identity || 'You are a helpful AI assistant.';
  let agentName = 'AI Assistant';
  console.log('Voice identifier:', voiceIdentifier);
  console.log('Using ElevenLabs voice ID:', agentVoiceId);
  
  // For Twilio calls, fetch agent voice and identity from database if agentId is provided
  if (agentId) {
    agentService.getAgentById('system', agentId).then(agent => {
      if (agent) {
        // Get voice ID
        if (agent.voiceId) {
          voiceIdentifier = agent.voiceId;
          agentVoiceId = voiceIdMap[voiceIdentifier] || voiceIdentifier;
          console.log('Fetched agent voice ID from database:', voiceIdentifier, '→', agentVoiceId);
        }
        // Get agent identity/prompt from database (override if not provided in query)
        if (agent.identity && !identity) {
          agentIdentity = agent.identity;
          console.log('Fetched agent identity from database');
        }
        // Get agent name
        if (agent.name) {
          agentName = agent.name;
          console.log('Fetched agent name:', agentName);
        }
      }
    }).catch(error => {
      console.error('Error fetching agent:', error);
    });
  }
  
  if (!deepgramApiKey) {
    console.warn('WARNING: DEEPGRAM_API_KEY is not configured. Speech-to-text will not work.');
  }
  if (!geminiApiKey) {
    console.warn('WARNING: GOOGLE_GEMINI_API_KEY is not configured. AI responses will not work.');
  }
  if (!elevenLabsApiKey) {
    console.warn('WARNING: ELEVEN_LABS_API_KEY is not configured. Text-to-speech will not work.');
  }
  
  // Handle incoming audio and text from the client
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.event === 'audio') {
        // Client is sending audio data
        audioChunksReceived++;
        audioBuffer.push(data.data);
        console.log('Received audio chunk', audioChunksReceived, 'from client (size:', data.data.length, ')');
        
        // Process every 10 chunks to batch transcription requests
        // But skip if already processing to prevent overlapping responses
        if (audioChunksReceived % 10 === 0 && deepgramApiKey && !isProcessing) {
          isProcessing = true; // Set flag before starting processing
          try {
            // Step 1: Send audio to Deepgram for transcription
            // Decode base64 audio chunks and combine them
            const audioBuffers = audioBuffer.map(chunk => Buffer.from(chunk, 'base64'));
            const combinedAudioBuffer = Buffer.concat(audioBuffers);
            
            console.log('Sending', combinedAudioBuffer.length, 'bytes of audio to Deepgram');
            
            const deepgramResponse = await nodeFetch('https://api.deepgram.com/v1/listen?model=nova-2&language=en&encoding=linear16&sample_rate=16000', {
              method: 'POST',
              headers: {
                'Authorization': `Token ${deepgramApiKey}`,
                'Content-Type': 'application/octet-stream'
              },
              body: combinedAudioBuffer
            });
            
            if (deepgramResponse.ok) {
              const deepgramResult = await deepgramResponse.json();
              const transcript = deepgramResult.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
              const confidence = deepgramResult.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;
              
              if (transcript) {
                console.log('Deepgram transcript:', transcript);
                
                // Step 2: Send transcript to Gemini for processing
                if (geminiApiKey) {
                  try {
                    // Use gemini-2.5-flash for best performance
                    // Build prompt with agent identity and user message
                    const systemPrompt = agentIdentity;
                    const userMessage = transcript;
                    const fullPrompt = systemPrompt + '\n\nUser: ' + userMessage;
                    
                    const geminiResponse = await nodeFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + geminiApiKey, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({
                        contents: [{
                          parts: [{
                            text: fullPrompt
                          }]
                        }]
                      })
                    });
                    
                    if (geminiResponse.ok) {
                      const geminiResult = await geminiResponse.json();
                      const agentResponse = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text || 'I could not generate a response.';
                      console.log('Gemini response:', agentResponse);
                      
                      // Step 3: Send Gemini response to ElevenLabs for text-to-speech
                      if (elevenLabsApiKey) {
                        try {
                          // Use the agent's configured voice ID
                          console.log('Sending text to ElevenLabs with voice ID:', agentVoiceId);
                          const ttsResponse = await nodeFetch(`https://api.elevenlabs.io/v1/text-to-speech/${agentVoiceId}`, {
                            method: 'POST',
                            headers: {
                              'xi-api-key': elevenLabsApiKey,
                              'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                              text: agentResponse,
                              voice_settings: {
                                stability: 0.5,
                                similarity_boost: 0.75
                              }
                            })
                          });
                          
                          if (ttsResponse.ok) {
                            const audioBuffer = await ttsResponse.arrayBuffer();
                            const audioBase64 = Buffer.from(audioBuffer).toString('base64');
                            
                            // Send audio back to client
                            ws.send(JSON.stringify({
                              event: 'audio',
                              audio: audioBase64
                            }));
                            
                            // Also send the transcript for display
                            ws.send(JSON.stringify({
                              event: 'transcript',
                              text: transcript,
                              confidence: confidence
                            }));
                            
                            // Send agent response for display
                            ws.send(JSON.stringify({
                              event: 'agent-response',
                              text: agentResponse
                            }));
                      
                          } else {
                            const errorText = await ttsResponse.text();
                            console.error('ElevenLabs TTS error:', ttsResponse.status, errorText);
                           // Check if the response is HTML (error page)
                            if (errorText.startsWith('<!DOCTYPE') || errorText.includes('<html')) {
                              console.error('ElevenLabs API returned HTML error page. Check API key and network connectivity.');
                              ws.send(JSON.stringify({
                                event: 'error',
                                message: 'ElevenLabs API configuration error. Please check API key.'
                              }));
                            } else {
                              // Parse JSON error if possible
                              try {
                                const errorJson = JSON.parse(errorText);
                                ws.send(JSON.stringify({
                                  event: 'error',
                                  message: `TTS Error: ${errorJson.detail?.message || errorJson.message || 'Failed to generate audio response'}`
                                }));
                              } catch (parseError) {
                                // If not JSON, send the raw error
                                ws.send(JSON.stringify({
                                  event: 'error',
                                  message: `TTS Error: ${errorText.substring(0, 200)}`
                                }));
                              }
                            }
                          }
                           // Clear processing flag after TTS processing (whether successful or not)
                          isProcessing = false;
                        } catch (ttsError) {
                          console.error('Error calling ElevenLabs TTS:', ttsError);
                          ws.send(JSON.stringify({
                            event: 'error',
                            message: 'Error converting response to speech'
                          }));
                          isProcessing = false;
                        }
                      } else {
                        // Send just the text response if TTS is not configured
                        ws.send(JSON.stringify({
                          event: 'agent-response',
                          text: agentResponse
                        }));
                        isProcessing = false;
                      }
                    } else {
                      const errorText = await geminiResponse.text();
                      console.error('Gemini API error:', geminiResponse.status, errorText);
                      ws.send(JSON.stringify({
                        event: 'error',
                        message: 'Gemini failed to process transcript'
                      }));
                      isProcessing = false;
                    }
                  } catch (geminiError) {
                    console.error('Error calling Gemini:', geminiError);
                    ws.send(JSON.stringify({
                      event: 'error',
                      message: 'Error processing with Gemini'
                    }));
                    isProcessing = false;
                  }
                } else {
                  // Send transcript if Gemini is not configured
                  ws.send(JSON.stringify({
                    event: 'transcript',
                    text: transcript,
                    confidence: confidence
                  }));
                  isProcessing = false;
                }
                
                // Clear buffer after successful transcription
                audioBuffer.length = 0;
                isProcessing = false; // Clear flag after processing complete
              }
            } else {
              const errorText = await deepgramResponse.text();
              console.error('Deepgram API error:', deepgramResponse.status, errorText);
              ws.send(JSON.stringify({
                event: 'error',
                message: `Deepgram error: ${deepgramResponse.status} - ${errorText.substring(0, 200)}`
              }));
              isProcessing = false;
            }
          } catch (transcriptionError) {
            console.error('Error in voice processing pipeline:', transcriptionError);
            ws.send(JSON.stringify({
              event: 'error',
              message: `Voice processing error: ${transcriptionError.message}`
            }));
            isProcessing = false;
          }
        } else if (audioChunksReceived % 10 === 0 && isProcessing) {
          console.log('Skipping audio processing - already processing previous response');
        }
      } else if (data.event === 'ping') {
        // Respond to client ping
        ws.send(JSON.stringify({ event: 'pong' }));
      }
    } catch (error) {
      console.error('Error processing voice stream message:', error);
    }
  });
  
  // Send a greeting message after connection
  setTimeout(() => {
    try {
      ws.send(JSON.stringify({
        event: 'message',
        text: 'Hello! I\'m ready to process your voice. I\'ll use Deepgram for speech-to-text, Gemini for AI responses, and ElevenLabs for text-to-speech.'
      }));
    } catch (error) {
      console.error('Error sending greeting:', error);
    }
  }, 500);
  
  ws.on('close', () => {
    console.log('Voice stream connection closed. Total audio chunks received:', audioChunksReceived);
    audioBuffer.length = 0;
  });
  
  ws.on('error', (error) => {
    console.error('Voice stream WebSocket error:', error);
  });
});

// Twilio number management endpoints
// Add a Twilio number for a user
app.post('/api/add-twilio-number', async (req, res) => {
  try {
    const { userId, phoneNumber, region, accountSid, authToken } = req.body;
    if (!userId || !phoneNumber || !region || !accountSid || !authToken) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const result = await twilioService.addTwilioNumber(userId, phoneNumber, region, accountSid, authToken);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error adding Twilio number:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Verify Twilio number with OTP
app.post('/api/verify-twilio-otp', async (req, res) => {
  try {
    const { userId, phoneNumber, otp } = req.body;
    if (!userId || !phoneNumber || !otp) {
      return res.status(400).json({ success: false, message: 'User ID, phone number, and OTP are required' });
    }

    const verified = await twilioService.verifyTwilioNumber(userId, phoneNumber, otp);
    res.json({ success: true, verified });
  } catch (error) {
    console.error('Error verifying Twilio number:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all Twilio numbers for a user
app.get('/api/twilio-numbers/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const numbers = await twilioService.getVerifiedNumbers(userId);
    res.json({ success: true, data: numbers });
  } catch (error) {
    console.error('Error fetching Twilio numbers:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Start server and bind to 0.0.0.0 for Railway
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

app.get("/db-conn-status", async (req, res) => {
  try {
    const conn = await mysqlPool.getConnection();
    await conn.ping();
    conn.release();

    res.json({ success: true, message: "MySQL connected successfully!" });
  } catch (error) {
    console.error("MYSQL CONNECTION ERROR:", error);
    res.json({ success: false, error: error.message || "No message" });
  }
});



