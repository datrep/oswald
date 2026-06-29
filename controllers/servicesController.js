const servicesModel = require("../models/servicesModel");

    async function getAllServices(req, res) {

        try {

            const services = await servicesModel.getAllServices();

            res.json(services);

        } catch (err) {

                    console.error("[ServicesController][getAllServices] Error:", err.stack);
            res.status(500).json({
                error: "Failed to fetch services",
                details: process.env.NODE_ENV === 'development' ? err.message : undefined
            });

        }
    }

async function createService(req, res) {

    try {
        const serviceData = req.body;
        const result = await servicesModel.createService(serviceData);
        res.status(201).json(result);
    } catch (err) {
        console.error("[ServicesController][createService]", err);
        res.status(500).json({
            error: "Failed to create service"
        });
    }
}

async function deleteService(req, res) {

    try {
        const id = req.params.id;
        const result = await servicesModel.deleteService(id);
        if (result) {
            res.status(200).json({ message: 'Service deleted successfully' });
        } else {
            res.status(404).json({ error: 'Service not found' });
        }
    } catch (err) {
        console.error('[ServicesController][deleteService]', err);
        res.status(500).json({
            error: 'Failed to delete service'
        });
    }
}

async function updateService(req, res) {

    try {
        const id = req.params.id;
        const serviceData = req.body;
        const result = await servicesModel.updateService(id, serviceData);
        if (result) {
            res.status(200).json(result);
        } else {
            res.status(404).json({ error: 'Service not found' });
        }
    } catch (err) {
        console.error('[ServicesController][updateService]', err);
        res.status(500).json({
            error: 'Failed to update service'
        });
    }
}

module.exports = {
    getAllServices,
    createService,
    deleteService,
    updateService
};