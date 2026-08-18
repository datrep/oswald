const servicesModel = require('../models/servicesModel');
const { NotFoundError } = require('../utils/errors');

async function getAllServices(req, res, next) {
  try {
    const services = await servicesModel.getAllServices();
    res.json(services);
  } catch (err) {
    next(err);
  }
}

async function createService(req, res, next) {
  try {
    const serviceData = req.body;
    const result = await servicesModel.createService(serviceData);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

async function deleteService(req, res, next) {
  try {
    const id = req.params.id;
    const result = await servicesModel.deleteService(id);
    if (result) {
      res.status(200).json({ success: true, message: 'Service deleted successfully' });
    } else {
      throw new NotFoundError('Service not found');
    }
  } catch (err) {
    next(err);
  }
}

async function updateService(req, res, next) {
  try {
    const id = req.params.id;
    const serviceData = req.body;
    const result = await servicesModel.updateService(id, serviceData);
    if (result) {
      res.status(200).json(result);
    } else {
      throw new NotFoundError('Service not found');
    }
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAllServices,
  createService,
  deleteService,
  updateService,
};
