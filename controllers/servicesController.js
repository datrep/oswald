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

module.exports = {
    getAllServices
};