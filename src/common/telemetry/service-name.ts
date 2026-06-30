// Identificador del microservicio. Se incluye en cada log/trace enviado a
// Application Insights (propiedad customDimensions.serviceName y cloud_RoleName)
// para poder filtrar por servicio vía KQL y distinguir el origen de cada log.
export const SERVICE_NAME = 'gateway';
