// validations/edictValidation.js
const Joi = require('joi');

const createEdictSchema = Joi.object({
    name: Joi.string().min(1).max(255).required(),
    plannedStart: Joi.date().iso().required(),
    plannedEnd: Joi.date().iso().min(Joi.ref('plannedStart')).allow(null),
    info: Joi.string().allow('', null),
    priority: Joi.number().integer().min(0).max(10).allow(null),
    state: Joi.number().integer().min(0).max(3).allow(null)
});

function validateCreateEdict(req, res, next) {
    const { error } = createEdictSchema.validate(req.body);
    if (error) {
        return res.status(400).json({ error: error.details[0].message });
    }
    next();
}

module.exports = { validateCreateEdict };