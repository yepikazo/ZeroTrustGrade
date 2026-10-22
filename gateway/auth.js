'use strict';

const express = require('express');

const login = require('./auth/login');
const refresh = require('./auth/refresh');
const logout = require('./auth/logout');
const service = require('./auth/service');

const router = express.Router();

// /auth/* ditangani langsung gateway (Policy Administrator).
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.post('/service', service);

module.exports = router;
