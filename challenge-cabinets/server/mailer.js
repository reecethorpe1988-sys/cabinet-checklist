// server/mailer.js — Nodemailer email sender
'use strict';
require('dotenv').config();
const nodemailer = require('nodemailer');

const RECIPIENTS = {
  matt:  process.env.RECIPIENT_MATT  || 'matt@challengecabinets.com.au',
  arron: process.env.RECIPIENT_ARRON || 'arron@challengecabinets.com.au',
  reece: process.env.RECIPIENT_REECE || 'reece@challengecabinets.com.au',
};

// Build transporter lazily (allows .env to be loaded first)
let _transporter = null;
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

// ─────────────────────────────────────────────
// HTML email template
// ─────────────────────────────────────────────
function buildHtml({ subject, projectName, milestone, note, dueDate, checklistType }) {
  const typeLabel = checklistType === 'stone' ? '🪨 Stone' : '🪚 Cabinet';
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: Inter, Arial, sans-serif; background: #EFEEEC; margin: 0; padding: 0; }
  .wrap { max-width: 560px; margin: 32px auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,.1); }
  .hdr  { background: #C8302A; padding: 22px 28px; }
  .hdr h1 { color: #fff; font-size: 22px; margin: 0; letter-spacing: 1px; font-family: Arial Black, sans-serif; }
  .hdr p  { color: rgba(255,255,255,.7); font-size: 12px; margin: 4px 0 0; letter-spacing: 1.5px; text-transform: uppercase; }
  .body  { padding: 28px; color: #1A1918; }
  .body p { font-size: 15px; line-height: 1.6; color: #4A4845; margin: 0 0 14px; }
  .highlight { background: #FDF1F0; border-left: 4px solid #C8302A; border-radius: 6px; padding: 14px 18px; margin: 18px 0; font-size: 14px; line-height: 1.7; }
  .highlight strong { color: #1A1918; }
  .type-pill { display: inline-block; background: #F0EDE8; border: 1px solid #C8C4BC; border-radius: 12px; padding: 2px 10px; font-size: 11px; font-weight: 700; color: #4A4845; margin-bottom: 12px; }
  .cta  { display: inline-block; background: #C8302A; color: #fff; padding: 12px 24px; border-radius: 7px; font-size: 14px; font-weight: 700; text-decoration: none; margin-top: 8px; }
  .footer { background: #3D3D3D; padding: 16px 28px; color: rgba(255,255,255,.45); font-size: 11px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Challenge Cabinets</h1>
    <p>Workshop Checklist — Automated Notification</p>
  </div>
  <div class="body">
    <span class="type-pill">${typeLabel} Checklist</span>
    <p>Hi team,</p>
    <p>A checklist milestone has been completed and requires your attention:</p>
    <div class="highlight">
      <strong>Project:</strong> ${projectName}<br>
      <strong>Milestone:</strong> ${milestone}<br>
      ${dueDate ? `<strong>Due:</strong> ${dueDate}<br>` : ''}
      ${note ? `<strong>Note:</strong> ${note}<br>` : ''}
    </div>
    <p>Please log in to the checklist system to review the current project status.</p>
  </div>
  <div class="footer">
    Challenge Cabinets Workshop Checklist System &nbsp;·&nbsp;
    This is an automated notification — do not reply to this email.
  </div>
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// sendNotification(options)
//   recipients: array of keys e.g. ['matt','arron','reece']
//               OR array of email strings
// ─────────────────────────────────────────────
async function sendNotification({ recipients, subject, projectName, milestone, note, dueDate, checklistType }) {
  const toAddresses = recipients.map(r => RECIPIENTS[r] || r).filter(Boolean);
  if (!toAddresses.length) throw new Error('No recipients specified');

  const html = buildHtml({ subject, projectName, milestone, note, dueDate, checklistType });

  const info = await getTransporter().sendMail({
    from:    process.env.SMTP_FROM || '"Challenge Cabinets" <noreply@challengecabinets.com.au>',
    to:      toAddresses.join(', '),
    subject: subject || `✅ ${milestone} — ${projectName}`,
    html,
    text: `${milestone}\n\nProject: ${projectName}\n${dueDate ? `Due: ${dueDate}\n` : ''}${note ? `Note: ${note}\n` : ''}\nThis is an automated notification from Challenge Cabinets Workshop Checklist.`,
  });

  return { messageId: info.messageId, to: toAddresses };
}

module.exports = { sendNotification, RECIPIENTS };
