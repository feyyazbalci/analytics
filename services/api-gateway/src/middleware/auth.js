const jwt = require('jsonwebtoken')

const authMiddleware = async (req, res, next) => {
    try{
        const token = req.header('Authorization')?.replace('Bearer', '');
        if (!token) {
            return res.status(401).json({
                error: 'Access denied. No token provided'
            })
        }

        //Verify JWT Token
        const decoded = jwt.verify(token, process.env.JWT_SECRET)

        // Add user info to request
        req.user = {
            id: decoded.userId,
            email: decoded.email,
            role: decoded.role || 'user'
        };

        // Check if user exists in cache
        const redis = req.app.get('redis')
        const userKey = `user:${req.user.id}`;
        const cachedUser = await redis.get(userKey);

        if (!cachedUser) {
            const userData = {
              id: req.user.id,
              email: req.user.email,
              role: req.user.role,
              lastActive: new Date().toISOString()
            };
            
            // Cache user for 1 hour
            await redis.setex(userKey, 3600, JSON.stringify(userData));
        }

        next();

    }catch(error){
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ 
              error: 'Invalid token.' 
            });
          }
          
          if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
              error: 'Token expired.' 
            });
          }
          
          console.error('❌ Auth middleware error:', error);
          return res.status(500).json({ 
            error: 'Internal server error.' 
          });
    }
};

module.exports = authMiddleware;