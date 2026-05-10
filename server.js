const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// 最大提交总份数限制（从环境变量读取，默认200）
const MAX_SUBMISSIONS = process.env.MAX_SUBMISSIONS ? parseInt(process.env.MAX_SUBMISSIONS) : 3;

app.set('trust proxy', 1);
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'graduation_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

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

const db = new sqlite3.Database('./graduation.db');
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            fullname TEXT NOT NULL,
            studentId TEXT NOT NULL UNIQUE,
            phone TEXT NOT NULL,
            email TEXT,
            photoPath TEXT,
            status TEXT DEFAULT 'unused',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            redeemed_at DATETIME
        )
    `);
    // 确保 studentId 字段有唯一索引（兼容旧表）
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_studentId ON submissions (studentId)`);
});

function generateRedeemCode() {
    return uuidv4().replace(/-/g, '').substring(0, 12).toUpperCase();
}

function getSubmissionByCode(code, callback) {
    db.get('SELECT * FROM submissions WHERE code = ?', [code], callback);
}

// 首页
app.get('/', (req, res) => {
    res.render('form', { error: null });
});

// 提交（带总数限制 + 学号重复检查）
app.post('/submit-form', upload.single('photo'), (req, res) => {
    const { fullname, studentId, phone, email } = req.body;
    if (!fullname || !studentId || !phone) {
        return res.render('form', { error: '请完整填写姓名、学号、手机号' });
    }

    // 第一步：检查总提交数限制
    db.get('SELECT COUNT(*) as count FROM submissions', (err, row) => {
        if (err) {
            console.error(err);
            return res.render('form', { error: '系统错误，请稍后重试' });
        }
        if (MAX_SUBMISSIONS !== null && row.count >= MAX_SUBMISSIONS) {
            return res.render('form', { error: `活动名额已满（上限 ${MAX_SUBMISSIONS} 人），无法继续报名。` });
        }
        // 第二步：检查学号重复
        db.get('SELECT id FROM submissions WHERE studentId = ?', [studentId], (err, row) => {
            if (err) {
                console.error(err);
                return res.render('form', { error: '系统错误，请稍后重试' });
            }
            if (row) {
                return res.render('form', { error: '该学号已经提交过申请，每人仅限一次！' });
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
    });
});

app.get('/success', (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');
    getSubmissionByCode(code, (err, submission) => {
        if (err || !submission) return res.status(404).send('核销码无效');
        const verifyUrl = `${req.protocol}://${req.get('host')}/redeem?code=${code}`;
        res.render('success', { code, verifyUrl });
    });
});

// 工作人员登录入口
app.get('/staff/login', (req, res) => {
    const redirect = req.query.redirect || '/';
    res.render('staffLogin', { error: null, redirect });
});

app.post('/staff/login', (req, res) => {
    const { password, redirect } = req.body;
    const staffPwd = process.env.STAFF_PASSWORD || 'Staff2026';
    if (password === staffPwd) {
        req.session.isStaff = true;
        res.redirect(redirect || '/');
    } else {
        res.render('staffLogin', { error: '密码错误', redirect: redirect || '/' });
    }
});

// 核销保护中间件
function requireStaff(req, res, next) {
    if (req.session.isStaff) return next();
    const redirectUrl = `/staff/login?redirect=${encodeURIComponent(req.originalUrl)}`;
    res.redirect(redirectUrl);
}

// 核销页面（受工作人员保护）
app.get('/redeem', requireStaff, (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('缺少核销码参数');
    getSubmissionByCode(code, (err, submission) => {
        if (err || !submission) return res.render('message', { title: '无效码', message: '该核销码不存在', type: 'error' });
        const isRedeemed = submission.status === 'redeemed';
        res.render('redeem', { submission, isRedeemed, code });
    });
});

// 执行核销 API（受保护）
app.post('/api/redeem', requireStaff, (req, res) => {
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
        const total = rows.length;
        const remaining = MAX_SUBMISSIONS ? (MAX_SUBMISSIONS - total) : null;
        const max = MAX_SUBMISSIONS;
        res.render('adminDashboard', { submissions: rows, total, remaining, max });
    });
});

// 管理员删除记录（同时删除照片）
app.delete('/api/submission/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    db.get('SELECT photoPath FROM submissions WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            return res.status(404).json({ success: false, message: '记录不存在' });
        }
        const photoPath = row.photoPath;
        db.run('DELETE FROM submissions WHERE id = ?', [id], function(err) {
            if (err) {
                console.error(err);
                return res.status(500).json({ success: false, message: '删除失败' });
            }
            if (photoPath) {
                const filePath = path.join(__dirname, photoPath);
                fs.unlink(filePath, (unlinkErr) => {
                    if (unlinkErr) console.error('删除照片文件失败:', unlinkErr);
                });
            }
            res.json({ success: true, message: '删除成功' });
        });
    });
});

app.listen(PORT, () => {
    console.log(`✅ 毕业季纪念徽章系统已启动: http://localhost:${PORT}`);
    console.log(`🔢 最大提交名额限制: ${MAX_SUBMISSIONS === null ? '无限制' : MAX_SUBMISSIONS}`);
});