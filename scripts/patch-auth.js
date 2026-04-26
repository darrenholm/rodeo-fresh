const fs = require("fs");
const authPath = "routes/auth.js";
let content = fs.readFileSync(authPath, "utf8");
content = content.replace(
  "user: {\n          id: user.id,\n          email: user.email,\n          name: user.name,\n          role: user.role,\n          roles: userRoles\n        }",
  "user: {\n          id: user.id,\n          email: user.email,\n          name: user.name,\n          role: user.role,\n          roles: userRoles,\n          must_change_password: user.must_change_password || false\n        }"
);
const newRoute = "\n// Change password endpoint\nrouter.post('/change-password', async (req, res) => {\n  try {\n    const { email, currentPassword, newPassword } = req.body;\n    if (!email || !currentPassword || !newPassword) {\n      return res.status(400).json({ error: 'All fields required' });\n    }\n    if (newPassword.length < 6) {\n      return res.status(400).json({ error: 'New password must be at least 6 characters' });\n    }\n    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);\n    if (rows.length === 0) {\n      return res.status(404).json({ error: 'User not found' });\n    }\n    const user = rows[0];\n    const valid = await bcrypt.compare(currentPassword, user.password);\n    if (!valid) {\n      return res.status(401).json({ error: 'Current password is incorrect' });\n    }\n    const hash = await bcrypt.hash(newPassword, 10);\n    await pool.query('UPDATE users SET password = $1, must_change_password = false WHERE id = $2', [hash, user.id]);\n    console.log('[auth] Password changed for:', email);\n    res.json({ success: true });\n  } catch (error) {\n    console.error('[auth] Change password error:', error);\n    res.status(500).json({ error: 'Failed to change password' });\n  }\n});\n\n";
content = content.replace("module.exports = router;", newRoute + "module.exports = router;");
fs.writeFileSync(authPath, content, "utf8");
console.log("Done!");
