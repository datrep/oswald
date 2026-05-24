const servicesModel = require("../models/servicesModel");

async function getAllServices(req, res) {

    try {

        const services = await servicesModel.getAllServices();

        res.json(services);

    } catch (err) {

        console.error("[ServicesController][getAllServices]", err);

        res.status(500).json({
            error: "Failed to fetch services"
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


module.exports = {
    getAllServices,
    createService
};