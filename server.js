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

// Helper function to read messages
async function getMessages() {
    try {
        const data = await fs.readFile(MESSAGES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // If file doesn't exist, return empty array
        return [];
    }
}

// Helper function to save a message
async function saveMessage(newMessage) {
    const messages = await getMessages();
    messages.unshift({
        id: Date.now(),
        date: new Date().toISOString(),
        ...newMessage
    });
    await fs.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

// Helper function to delete a message
async function deleteMessageById(id) {
    const messages = await getMessages();
    const filtered = messages.filter(m => String(m.id) !== String(id));
    await fs.writeFile(MESSAGES_FILE, JSON.stringify(filtered, null, 2));
    return filtered.length < messages.length;
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

    // Save message locally
    await saveMessage({
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
        res.status(200).json({ success: true, message: 'Message sent successfully!' });
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(200).json({ success: true, message: 'Message saved successfully! (Email notification pending configuration).' });
    }
});

// API Endpoint to get all messages (Protected)
app.get('/api/messages', requireAdmin, async (req, res) => {
    const messages = await getMessages();
    res.json({ success: true, messages });
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
