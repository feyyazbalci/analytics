const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const router = express.Router();

// Sample users for demo
const sampleUsers = [
  {
    id: 1,
    email: 'admin@example.com',
    password: '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', // password: secret
    role: 'admin',
    firstName: 'Admin',
    lastName: 'User'
  },
  {
    id: 2,
    email: 'user@example.com',
    password: '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', // password: secret
    role: 'user',
    firstName: 'Demo',
    lastName: 'User'
  }
];

// Validation middleware
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation failed', 
      details: errors.array() 
    });
  }
  next();
};

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], validateRequest, async (req, res) => {
  try {
    const { email, password } = req.body;

    
    const user = sampleUsers.find(u => u.email === email);
    if (!user) {
      return res.status(401).json({ 
        error: 'Invalid credentials' 
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ 
        error: 'Invalid credentials' 
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        role: user.role 
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    const redis = req.app.get('redis');
    const sessionKey = `session:${user.id}:${Date.now()}`;
    await redis.setex(sessionKey, 86400, JSON.stringify({
      userId: user.id,
      email: user.email,
      role: user.role,
      loginTime: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    }));

    // Update user activity
    const today = new Date().toISOString().split('T')[0];
    await redis.sadd(`users:active:${today}`, user.id);
    await redis.sadd('users:online', user.id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role
      },
      expiresIn: '24h'
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').isLength({ min: 2 }),
  body('lastName').isLength({ min: 2 })
], validateRequest, async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    // Check if user already exists
    const existingUser = sampleUsers.find(u => u.email === email);
    if (existingUser) {
      return res.status(409).json({ 
        error: 'User already exists' 
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user (in production, save to database)
    const newUser = {
      id: sampleUsers.length + 1,
      email,
      password: hashedPassword,
      firstName,
      lastName,
      role: 'user',
      createdAt: new Date().toISOString()
    };

    // For demo purposes, just add to memory
    sampleUsers.push(newUser);

    // Generate token
    const token = jwt.sign(
      { 
        userId: newUser.id, 
        email: newUser.email, 
        role: newUser.role 
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Update metrics
    const redis = req.app.get('redis');
    const today = new Date().toISOString().split('T')[0];
    await redis.sadd(`users:new:${today}`, newUser.id);
    await redis.sadd(`users:active:${today}`, newUser.id);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        role: newUser.role
      },
      expiresIn: '24h'
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const redis = req.app.get('redis');
      
      // Remove from online users
      await redis.srem('users:online', decoded.userId);
      
      // Blacklist token
      await redis.setex(`blacklist:${token}`, 86400, 'true');
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.json({ success: true, message: 'Logged out' }); // Always succeed
  }
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = sampleUsers.find(u => u.id === decoded.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// GET /api/auth/demo-token
router.get('/demo-token', async (req, res) => {
  try {
    // Generate demo token for testing
    const demoUser = sampleUsers[0]; // admin user
    
    const token = jwt.sign(
      { 
        userId: demoUser.id, 
        email: demoUser.email, 
        role: demoUser.role 
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      success: true,
      token,
      message: 'Demo token generated (expires in 1 hour)',
      user: {
        email: demoUser.email,
        role: demoUser.role
      }
    });

  } catch (error) {
    console.error('❌ Demo token error:', error);
    res.status(500).json({ error: 'Failed to generate demo token' });
  }
});

module.exports = router;