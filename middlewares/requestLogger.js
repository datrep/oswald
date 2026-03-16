
function requestLogger(req, res, next) {

    const start = Date.now();

    console.log("\n==============================");
    console.log(`REQUEST START`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Method: ${req.method}`);
    console.log(`URL: ${req.originalUrl}`);

    if (Object.keys(req.query).length > 0)
        console.log("Query:", req.query);

    if (Object.keys(req.body || {}).length > 0)
        console.log("Body:", req.body);


    res.on("finish", () => {

        const duration = Date.now() - start;

        console.log(`RESPONSE`);
        console.log(`Status: ${res.statusCode}`);
        console.log(`Duration: ${duration}ms`);
        console.log("==============================\n");

    });

    next();

}

module.exports = requestLogger;