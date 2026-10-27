require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Route for resume download
const RESUME_FILE = path.join(__dirname, 'HASEN_BASHREE_Resume_7-2.pdf');
app.get(['/assets/resume.pdf', '/resume.pdf'], (req, res) => {
    res.sendFile(RESUME_FILE);
});

// Serve static files (HTML, CSS, JS) from the current directory
app.use(express.static(__dirname));

// Setup Nodemailer transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Admin authentication middleware
function requireAdmin(req, res, next) {
    const adminPass = process.env.ADMIN_PASSWORD;
    const provided = req.headers['x-admin-password'];
    if (!adminPass || !provided || provided !== adminPass) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    next();
}

const MESSAGES_BACKUP = path.join(__dirname, 'messages.json.bak');
const MESSAGES_TMP = path.join(__dirname, 'messages.json.tmp');

// Serial queue for atomic messages.json persistence
let messageWriteQueue = Promise.resolve();

async function saveMessagesSafely(messagesArray) {
    messageWriteQueue = messageWriteQueue.then(async () => {
        const jsonStr = JSON.stringify(messagesArray, null, 2);
        await fs.writeFile(MESSAGES_TMP, jsonStr, 'utf8');
        try {
            await fs.copyFile(MESSAGES_FILE, MESSAGES_BACKUP);
        } catch (_) {}
        await fs.rename(MESSAGES_TMP, MESSAGES_FILE);
    }).catch(err => {
        console.error('Error writing messages safely:', err);
        throw err;
    });
    return messageWriteQueue;
}

// Helper function to read and normalize messages
async function getMessages() {
    try {
        const data = await fs.readFile(MESSAGES_FILE, 'utf8');
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(m => ({
            id: m.id || Date.now(),
            date: m.date || new Date().toISOString(),
            name: m.name || '',
            email: m.email || '',
            subject: m.subject || '',
            message: m.message || '',
            status: m.status || 'New',
            replies: Array.isArray(m.replies) ? m.replies : []
        })).sort((a, b) => new Date(b.date) - new Date(a.date));
    } catch (error) {
        return [];
    }
}

// Helper function to save a new message
async function saveMessage(newMessage) {
    const messages = await getMessages();
    const createdMessage = {
        id: Date.now(),
        date: new Date().toISOString(),
        name: newMessage.name,
        email: newMessage.email,
        subject: newMessage.subject,
        message: newMessage.message,
        status: 'New',
        replies: []
    };
    messages.unshift(createdMessage);
    await saveMessagesSafely(messages);
    return createdMessage;
}

// Helper function to delete a message
async function deleteMessageById(id) {
    const messages = await getMessages();
    const filtered = messages.filter(m => String(m.id) !== String(id));
    if (filtered.length === messages.length) return false;
    await saveMessagesSafely(filtered);
    return true;
}

// Server-Sent Events (SSE) clients for real-time live synchronization
const sseClients = new Set();

function notifyClients(event = 'content-updated', data = {}) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(payload);
        } catch (err) {
            sseClients.delete(client);
        }
    }
}

// SSE stream endpoint
app.get('/api/content/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
    });
    res.write('data: connected\n\n');
    sseClients.add(res);

    req.on('close', () => {
        sseClients.delete(res);
    });
});

// API Endpoint to handle form submissions
app.post('/api/contact', async (req, res) => {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
        return res.status(400).json({ success: false, message: 'Please provide name, email, and message.' });
    }

    const trimmedName = String(name).trim().slice(0, 100);
    const trimmedEmail = String(email).trim().slice(0, 120);
    const trimmedSubject = subject ? String(subject).trim().slice(0, 200) : '';
    const trimmedMessage = String(message).trim().slice(0, 5000);

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
        return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
    }

    // Save message locally first with status New
    const saved = await saveMessage({
        name: trimmedName,
        email: trimmedEmail,
        subject: trimmedSubject,
        message: trimmedMessage
    });

    const mailOptions = {
        from: `"${trimmedName}" <${process.env.EMAIL_USER}>`, 
        replyTo: trimmedEmail,
        to: process.env.RECEIVER_EMAIL || process.env.EMAIL_USER,
        subject: trimmedSubject || 'New Contact Form Submission',
        text: `You have received a new message from your portfolio website.\n\nName: ${trimmedName}\nEmail: ${trimmedEmail}\n\nMessage:\n${trimmedMessage}`,
        html: `
            <h3>New Contact Form Submission</h3>
            <p><strong>Name:</strong> ${trimmedName.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
            <p><strong>Email:</strong> ${trimmedEmail.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
            <p><strong>Subject:</strong> ${(trimmedSubject || 'N/A').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
            <p><strong>Message:</strong></p>
            <p>${trimmedMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully');
        res.status(200).json({ success: true, message: 'Message sent successfully!', messageId: saved.id });
    } catch (error) {
        console.error('Error sending notification email:', error.message || error);
        res.status(200).json({ success: true, message: 'Message saved successfully! (Notification email pending configuration).', messageId: saved.id });
    }
});

// API Endpoint to get all messages (Protected)
app.get('/api/messages', requireAdmin, async (req, res) => {
    const messages = await getMessages();
    res.json({ success: true, messages });
});

// API Endpoint to update message status (Protected)
app.patch('/api/messages/:id/status', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!status || !['New', 'Read', 'Replied'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Valid status required: New, Read, or Replied.' });
    }
    const messages = await getMessages();
    const target = messages.find(m => String(m.id) === String(id));
    if (!target) {
        return res.status(404).json({ success: false, message: 'Message not found.' });
    }
    target.status = status;
    await saveMessagesSafely(messages);
    res.json({ success: true, message: `Message status updated to ${status}.`, status: target.status });
});

// API Endpoint to reply to a visitor (Protected)
app.post('/api/messages/:id/reply', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { replyText } = req.body;

    if (!replyText || !String(replyText).trim()) {
        return res.status(400).json({ success: false, message: 'Reply text cannot be empty.' });
    }

    const messages = await getMessages();
    const target = messages.find(m => String(m.id) === String(id));
    if (!target) {
        return res.status(404).json({ success: false, message: 'Message not found.' });
    }

    if (!target.email || !target.email.includes('@')) {
        return res.status(400).json({ success: false, message: 'Recipient email is invalid or missing.' });
    }

    const cleanReply = String(replyText).trim();
    const cleanSubject = target.subject && target.subject.toLowerCase().startsWith('re:') 
        ? target.subject 
        : `Re: ${target.subject || 'Your message on Hasen Portfolio'}`;

    const senderEmail = process.env.EMAIL_USER || 'hasenbashree@gmail.com';

    const mailOptions = {
        from: `"Hasen Bashree" <${senderEmail}>`,
        to: target.email,
        replyTo: senderEmail,
        subject: cleanSubject,
        text: cleanReply,
        html: `
            <div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.6;color:#1e293b;max-width:620px;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;padding:24px;">
                <h3 style="color:#2563eb;margin-top:0;">Response from Hasen Bashree</h3>
                <p>Hi ${target.name || 'there'},</p>
                <div style="padding:14px 18px;background:#f8fafc;border-left:4px solid #2563eb;margin:16px 0;border-radius:4px;font-size:0.95rem;">
                    <p style="white-space:pre-wrap;margin:0;">${cleanReply.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>
                </div>
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
                <p style="font-size:0.85rem;color:#64748b;margin-bottom:6px;"><strong>In response to your message:</strong></p>
                <blockquote style="font-size:0.85rem;color:#64748b;border-left:2px solid #cbd5e1;padding-left:12px;margin:0;font-style:italic;">
                    ${(target.message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}
                </blockquote>
                <p style="margin-top:24px;font-size:0.9rem;color:#334155;">Best regards,<br><strong>Hasen Bashree</strong></p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Reply successfully delivered to ${target.email}`);

        const replyRecord = {
            id: Date.now(),
            sentAt: new Date().toISOString(),
            replyText: cleanReply,
            sentBy: senderEmail,
            status: 'Delivered'
        };

        if (!Array.isArray(target.replies)) target.replies = [];
        target.replies.push(replyRecord);
        target.status = 'Replied';

        await saveMessagesSafely(messages);

        res.json({
            success: true,
            message: 'Reply sent successfully!',
            reply: replyRecord,
            status: target.status
        });
    } catch (error) {
        console.error('Failed to send reply email:', error);
        res.status(500).json({
            success: false,
            message: `Email delivery failed: ${error.message || 'SMTP error'}. Please verify EMAIL_USER and EMAIL_PASS configuration.`
        });
    }
});

// API Endpoint to delete a message (Protected)
app.delete('/api/messages/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await deleteMessageById(id);
        if (deleted) {
            res.json({ success: true, message: 'Message deleted successfully.' });
        } else {
            res.status(404).json({ success: false, message: 'Message not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete message.' });
    }
});

const CONTENT_FILE = path.join(__dirname, 'content.json');
const CONTENT_BACKUP = path.join(__dirname, 'content.json.bak');
const CONTENT_TMP = path.join(__dirname, 'content.json.tmp');

// Safe atomic file writing helper
async function saveContentSafely(contentObj) {
    const jsonStr = JSON.stringify(contentObj, null, 2);
    await fs.writeFile(CONTENT_TMP, jsonStr, 'utf8');
    try {
        await fs.copyFile(CONTENT_FILE, CONTENT_BACKUP);
    } catch (_) {}
    await fs.rename(CONTENT_TMP, CONTENT_FILE);
}

// API Endpoint to get portfolio content
app.get('/api/content', async (req, res) => {
    try {
        const data = await fs.readFile(CONTENT_FILE, 'utf8');
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not load content' });
    }
});

// API Endpoint to update portfolio content (Protected)
app.post('/api/content', requireAdmin, async (req, res) => {
    const content = req.body;
    if (!content || typeof content !== 'object') {
        return res.status(400).json({ success: false, message: 'Invalid content format.' });
    }

    // Validate expected structure
    if (content.techStack && !Array.isArray(content.techStack)) {
        return res.status(400).json({ success: false, message: 'techStack must be an array.' });
    }
    if (content.projects && !Array.isArray(content.projects)) {
        return res.status(400).json({ success: false, message: 'projects must be an array.' });
    }
    if (content.blogPosts && !Array.isArray(content.blogPosts)) {
        return res.status(400).json({ success: false, message: 'blogPosts must be an array.' });
    }
    if (content.testimonials && !Array.isArray(content.testimonials)) {
        return res.status(400).json({ success: false, message: 'testimonials must be an array.' });
    }
    if (content.translations && (typeof content.translations !== 'object' || Array.isArray(content.translations))) {
        return res.status(400).json({ success: false, message: 'translations must be an object.' });
    }

    try {
        await saveContentSafely(content);
        // Notify live visitors that content was updated
        notifyClients('content-updated', { timestamp: Date.now() });
        res.json({ success: true, message: 'Content updated successfully!' });
    } catch (error) {
        console.error('Failed to update content:', error);
        res.status(500).json({ success: false, message: 'Failed to update content.' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
