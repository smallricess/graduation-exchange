const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// 使用环境变量中的公网地址（Railway 自动提供），或本地开发默认
app.set('trust proxy', 1);

// 配置静态文件目录
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// Session 配置（用于管理员登录）
app.use(session({
    secret: process.env.SESSION_SECRET || 'graduation_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 } // 一天
}));

// 确保 uploads 文件夹存在
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer 配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
    }
});
const upload = multer({ 
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif/;
        const mimetype = allowed.test(file.mimetype);
        const extname = allowed.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        cb(new Error('只支持图片格式'));
    }
});

// 初始化数据库
const db = new sqlite3.Database('./graduation.db');
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            fullname TEXT NOT NULL,
            studentId TEXT NOT NULL,
            phone TEXT NOT NULL,
            email TEXT,
            photoPath TEXT,
            status TEXT DEFAULT 'unused',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            redeemed_at DATETIME
        )
    `);
});

// 生成唯一核销码
function generateRedeemCode() {
    return uuidv4().replace(/-/g, '').substring(0, 12).toUpperCase();
}

function getSubmissionByCode(code, callback) {
    db.get('SELECT * FROM submissions WHERE code = ?', [code], callback);
}

// 首页表单
app.get('/', (req, res) => {
    res.render('form', { error: null });
});

// 提交表单
app.post('/submit-form', upload.single('photo'), (req, res) => {
    const { fullname, studentId, phone, email } = req.body;
    if (!fullname || !studentId || !phone) {
        return res.render('form', { error: '请完整填写姓名、学号、手机号' });
    }
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
    const code = generateRedeemCode();

    db.run(`INSERT INTO submissions (code, fullname, studentId, phone, email, photoPath) 
            VALUES (?, ?, ?, ?, ?, ?)`,
        [code, fullname, studentId, phone, email || null, photoPath],
        function(err) {
            if (err) {
                console.error(err);
                return res.render('form', { error: '提交失败，请稍后重试' });
            }
            res.redirect(`/success?code=${code}`);
        });
});

// 成功页 + 二维码
app.get('/success', (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');
    getSubmissionByCode(code, (err, submission) => {
        if (err || !submission) return res.status(404).send('核销码无效');
        const verifyUrl = `${req.protocol}://${req.get('host')}/redeem?code=${code}`;
        res.render('success', { code, verifyUrl });
    });
});

// 核销页面（工作人员扫码访问）
app.get('/redeem', (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('缺少核销码参数');
    getSubmissionByCode(code, (err, submission) => {
        if (err || !submission) return res.render('message', { title: '无效码', message: '该核销码不存在', type: 'error' });
        const isRedeemed = submission.status === 'redeemed';
        res.render('redeem', { submission, isRedeemed, code });
    });
});

// 执行核销 API
app.post('/api/redeem', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: '缺少核销码' });
    db.get('SELECT status FROM submissions WHERE code = ?', [code], (err, row) => {
        if (err || !row) return res.status(404).json({ success: false, message: '核销码无效' });
        if (row.status === 'redeemed') {
            return res.json({ success: false, message: '该码已被使用过，无法重复兑换' });
        }
        db.run('UPDATE submissions SET status = ?, redeemed_at = CURRENT_TIMESTAMP WHERE code = ?', ['redeemed', code], function(err) {
            if (err) return res.status(500).json({ success: false, message: '服务器错误' });
            res.json({ success: true, message: '核销成功！纪念徽章已兑换 ✔️' });
        });
    });
});

// 管理员后台
app.get('/admin/login', (req, res) => {
    res.render('adminLogin', { error: null });
});
app.post('/admin/login', (req, res) => {
    const adminPwd = process.env.ADMIN_PASSWORD || 'Grad2026@Admin';
    if (req.body.password === adminPwd) {
        req.session.isAdmin = true;
        res.redirect('/admin/dashboard');
    } else {
        res.render('adminLogin', { error: '密码错误' });
    }
});
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});
function requireAdmin(req, res, next) {
    if (req.session.isAdmin) return next();
    res.redirect('/admin/login');
}
app.get('/admin/dashboard', requireAdmin, (req, res) => {
    db.all('SELECT * FROM submissions ORDER BY created_at DESC', [], (err, rows) => {
        if (err) return res.status(500).send('数据库错误');
        res.render('adminDashboard', { submissions: rows });
    });
});

app.listen(PORT, () => {
    console.log(`✅ 毕业季纪念徽章系统已启动: http://localhost:${PORT}`);
});