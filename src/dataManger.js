const fs = require('fs').promises;
const path = require('path');
const moment = require('moment');

class DataManager {
    constructor() {
        this.baseDir = path.join(__dirname, '..', 'data');
        this.dirs = {
            camera: path.join(this.baseDir, 'camera_captures'),
            system: path.join(this.baseDir, 'system_info'),
            location: path.join(this.baseDir, 'location_data'),
            logs: path.join(this.baseDir, 'logs')
        };
        this.initialize();
    }

    async initialize() {
        // 创建所需的目录
        for (const dir of Object.values(this.dirs)) {
            await fs.mkdir(dir, { recursive: true });
        }
    }

    async saveCameraImage(imageData, deviceId) {
        const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
        const filename = `${deviceId}_${timestamp}.jpg`;
        const filepath = path.join(this.dirs.camera, filename);
        
        // 将Base64图像数据保存为文件
        const base64Data = imageData.replace(/^data:image\/jpeg;base64,/, '');
        await fs.writeFile(filepath, base64Data, 'base64');
        
        return filename;
    }

    async saveSystemInfo(data, deviceId) {
        const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
        const filename = `${deviceId}_${timestamp}.json`;
        const filepath = path.join(this.dirs.system, filename);
        
        await fs.writeFile(filepath, JSON.stringify(data, null, 2));
        return filename;
    }

    async saveLocationData(data, deviceId) {
        const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
        const filename = `${deviceId}_${timestamp}.json`;
        const filepath = path.join(this.dirs.location, filename);
        
        await fs.writeFile(filepath, JSON.stringify(data, null, 2));
        return filename;
    }

    async saveLog(message, type = 'info', deviceId) {
        const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
        const logEntry = `[${timestamp}] [${type.toUpperCase()}] [${deviceId}] ${message}\n`;
        const logFile = path.join(this.dirs.logs, `${moment().format('YYYY-MM-DD')}.log`);
        
        await fs.appendFile(logFile, logEntry);
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

module.exports = new DataManager(); 
