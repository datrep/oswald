const servicesModel = require('../models/servicesModel');
const { NotFoundError, asyncHandler } = require('../utils/errors');

const getAllServices = asyncHandler(async (req, res) => {
  res.json(await servicesModel.getAllServices());
});

const createService = asyncHandler(async (req, res) => {
  const result = await servicesModel.createService(req.body);
  res.status(201).json(result);
});

const deleteService = asyncHandler(async (req, res) => {
  const affected = await servicesModel.deleteService(req.params.id);
  if (!affected) throw new NotFoundError('Service not found');
  res.json({ success: true, message: 'Service deleted successfully' });
});

const updateService = asyncHandler(async (req, res) => {
  const affected = await servicesModel.updateService(req.params.id, req.body);
  if (!affected) throw new NotFoundError('Service not found');
  res.json({ success: true, message: 'Service updated successfully' });
});

module.exports = {
  getAllServices,
  createService,
  deleteService,
  updateService,
};
