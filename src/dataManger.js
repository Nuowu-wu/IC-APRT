const fs = require('fs').promises;
const path = require('path');
const moment = require('moment');

class DataManager {
    constructor() {
        // 使用环境变量或默认值来设置基础目录
        const baseDir = process.env.DATA_DIR || 'data';
        
        // 确保路径是绝对路径
        this.baseDir = path.isAbsolute(baseDir) ? baseDir : path.join(process.cwd(), baseDir);
        
        // 定义子目录
        this.dirs = {
            camera: path.join(this.baseDir, 'camera_captures'),
            system: path.join(this.baseDir, 'system_info'),
            location: path.join(this.baseDir, 'location_data'),
            logs: path.join(this.baseDir, 'logs')
        };

        // 异步初始化目录
        this.initPromise = this.initialize().catch(err => {
            console.error('Error initializing directories:', err);
        });
    }

    async initialize() {
        try {
            // 创建所需的目录
            for (const dir of Object.values(this.dirs)) {
                try {
                    await fs.mkdir(dir, { recursive: true });
                    console.log(`Directory created/verified: ${dir}`);
                } catch (err) {
                    console.warn(`Warning: Could not create directory ${dir}:`, err.message);
                }
            }
        } catch (err) {
            console.error('Failed to initialize directories:', err);
            // 不抛出错误，让应用程序继续运行
        }
    }

    async ensureInitialized() {
        await this.initPromise;
    }

    async saveCameraImage(imageData, deviceId) {
        await this.ensureInitialized();
        try {
            const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
            const filename = `${deviceId}_${timestamp}.jpg`;
            const filepath = path.join(this.dirs.camera, filename);
            
            const base64Data = imageData.replace(/^data:image\/jpeg;base64,/, '');
            await fs.writeFile(filepath, base64Data, 'base64');
            
            return filename;
        } catch (err) {
            console.error('Error saving camera image:', err);
            throw err;
        }
    }

    async saveSystemInfo(data, deviceId) {
        await this.ensureInitialized();
        try {
            const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
            const filename = `${deviceId}_${timestamp}.json`;
            const filepath = path.join(this.dirs.system, filename);
            
            await fs.writeFile(filepath, JSON.stringify(data, null, 2));
            return filename;
        } catch (err) {
            console.error('Error saving system info:', err);
            throw err;
        }
    }

    async saveLocationData(data, deviceId) {
        await this.ensureInitialized();
        try {
            const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
            const filename = `${deviceId}_${timestamp}.json`;
            const filepath = path.join(this.dirs.location, filename);
            
            await fs.writeFile(filepath, JSON.stringify(data, null, 2));
            return filename;
        } catch (err) {
            console.error('Error saving location data:', err);
            throw err;
        }
    }

    async saveLog(message, type = 'info', deviceId) {
        await this.ensureInitialized();
        try {
            const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
            const logEntry = `[${timestamp}] [${type.toUpperCase()}] [${deviceId}] ${message}\n`;
            const logFile = path.join(this.dirs.logs, `${moment().format('YYYY-MM-DD')}.log`);
            
            await fs.appendFile(logFile, logEntry);
        } catch (err) {
            console.error('Error saving log:', err);
            // 继续执行，不抛出错误
        }
    }

    async getDeviceHistory(deviceId, type, limit = 10) {
        const dir = this.dirs[type];
        const files = await fs.readdir(dir);
        
        // 筛选指定设备的文件并按时间排序
        const deviceFiles = files
            .filter(file => file.startsWith(deviceId))
            .sort()
            .reverse()
            .slice(0, limit);
            
        const results = [];
        for (const file of deviceFiles) {
            const filepath = path.join(dir, file);
            const content = await fs.readFile(filepath, 'utf8');
            results.push({
                timestamp: moment(file.split('_')[1].split('.')[0], 'YYYY-MM-DD_HH-mm-ss').toDate(),
                data: JSON.parse(content)
            });
        }
        
        return results;
    }

    async cleanup(daysToKeep = 7) {
        const cutoff = moment().subtract(daysToKeep, 'days');
        
        for (const [type, dir] of Object.entries(this.dirs)) {
            const files = await fs.readdir(dir);
            
            for (const file of files) {
                const filepath = path.join(dir, file);
                const stats = await fs.stat(filepath);
                const fileDate = moment(stats.mtime);
                
                if (fileDate.isBefore(cutoff)) {
                    await fs.unlink(filepath);
                    await this.saveLog(`Cleaned up old file: ${file}`, 'info', 'system');
                }
            }
        }
    }
}

// 创建单例实例
const dataManager = new DataManager();

// 导出实例
module.exports = dataManager; 
