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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup Nodemailer transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

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

// API Endpoint to handle form submissions
app.post('/api/contact', async (req, res) => {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
        return res.status(400).json({ success: false, message: 'Please provide name, email, and message.' });
    }

    // Save message locally
    await saveMessage({ name, email, subject, message });

    const mailOptions = {
        from: `"${name}" <${process.env.EMAIL_USER}>`, 
        replyTo: email,
        to: process.env.RECEIVER_EMAIL || process.env.EMAIL_USER,
        subject: subject || 'New Contact Form Submission',
        text: `You have received a new message from your portfolio website.\n\nName: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
        html: `
            <h3>New Contact Form Submission</h3>
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Subject:</strong> ${subject || 'N/A'}</p>
            <p><strong>Message:</strong></p>
            <p>${message.replace(/\n/g, '<br>')}</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully');
        res.status(200).json({ success: true, message: 'Message sent successfully!' });
    } catch (error) {
        console.error('Error sending email:', error);
        // Even if email fails, message is saved, but we return success so user doesn't panic, or error. 
        // Let's return success but log error, since it's saved.
        res.status(500).json({ success: false, message: 'Failed to send email, but message was saved.' });
    }
});

// API Endpoint to get all messages (Protected)
app.get('/api/messages', async (req, res) => {
    const password = req.headers['x-admin-password'];
    
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const messages = await getMessages();
    res.json({ success: true, messages });
});

const CONTENT_FILE = path.join(__dirname, 'content.json');

// API Endpoint to get portfolio content
app.get('/api/content', async (req, res) => {
    try {
        const data = await fs.readFile(CONTENT_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not load content' });
    }
});

// API Endpoint to update portfolio content (Protected)
app.post('/api/content', async (req, res) => {
    const password = req.headers['x-admin-password'];
    
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        await fs.writeFile(CONTENT_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'Content updated successfully!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update content' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
