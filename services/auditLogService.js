const pool = require('../config/database');

/**
 * Registers an audit log entry.
 *
 * @param {number | null} userId - The ID of the user performing the action. Can be null for system actions.
 * @param {string | null} userEmail - The email of the user performing the action.
 * @param {string} actionType - The type of action performed (e.g., 'CLIENT_CREATED', 'USER_LOGIN_FAILED').
 * @param {string | null} entityType - The type of entity affected (e.g., 'Client', 'User').
 * @param {string | number | null} entityId - The ID of the entity affected.
 * @param {object | null} details - Additional details about the action (e.g., old and new values for updates).
 */
async function logAction(userId, userEmail, actionType, entityType = null, entityId = null, details = null) {
  try {
    const query = `
      INSERT INTO audit_logs (user_id, user_email, action_type, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id;
    `;
    const values = [userId, userEmail, actionType, entityType, entityId, details ? JSON.stringify(details) : null];
    
    const result = await pool.query(query, values);
    console.log(`Audit log created: ID ${result.rows[0].id}, Action: ${actionType}, UserID: ${userId || 'System'}`);
    return result.rows[0].id;
  } catch (error) {
    console.error('Error creating audit log:', error.stack);
    // Decide if you want to throw the error or handle it silently
    // For critical audit logs, you might not want to interrupt the main operation
    // For less critical, or if logging failure is a major issue, you might throw
  }
}

module.exports = {
  logAction,
  ACTION_TYPES: {
    // User actions
    USER_CREATED: 'USER_CREATED',
    USER_UPDATED: 'USER_UPDATED',
    USER_PASSWORD_UPDATED: 'USER_PASSWORD_UPDATED',
    USER_DELETED: 'USER_DELETED',
    USER_LOGIN_SUCCESS: 'USER_LOGIN_SUCCESS',
    USER_LOGIN_FAILED: 'USER_LOGIN_FAILED', // Example, if you want to log failed attempts
    
    // Client actions
    CLIENT_CREATED: 'CLIENT_CREATED',
    CLIENT_UPDATED: 'CLIENT_UPDATED',
    CLIENT_DELETED: 'CLIENT_DELETED',

    // CRM Occurrence actions
    CRM_OCCURRENCE_CREATED: 'CRM_OCCURRENCE_CREATED',
    CRM_OCCURRENCE_UPDATED: 'CRM_OCCURRENCE_UPDATED',
    CRM_OCCURRENCE_DELETED: 'CRM_OCCURRENCE_DELETED',

    // Gestor Occurrence actions
    GESTOR_OCCURRENCE_CREATED: 'GESTOR_OCCURRENCE_CREATED',
    GESTOR_OCCURRENCE_UPDATED: 'GESTOR_OCCURRENCE_UPDATED',
    GESTOR_OCCURRENCE_DELETED: 'GESTOR_OCCURRENCE_DELETED',

    FATURAMENTO_CREATED: 'FATURAMENTO_CREATED',
FATURAMENTO_UPDATED: 'FATURAMENTO_UPDATED',
FATURAMENTO_DELETED: 'FATURAMENTO_DELETED',
FATURAMENTO_LISTED: 'FATURAMENTO_LISTED', // Se quiser logar listagens
FATURAMENTO_ACCESS_DENIED: 'FATURAMENTO_ACCESS_DENIED',
FATURAMENTO_CREATE_FAILED: 'FATURAMENTO_CREATE_FAILED',
FATURAMENTO_CREATE_FAILED_DUPLICATE: 'FATURAMENTO_CREATE_FAILED_DUPLICATE',
FATURAMENTO_CREATE_FAILED_INVALID_CLIENT: 'FATURAMENTO_CREATE_FAILED_INVALID_CLIENT',
FATURAMENTO_LIST_FAILED: 'FATURAMENTO_LIST_FAILED',
FATURAMENTO_UPDATE_FAILED: 'FATURAMENTO_UPDATE_FAILED',
FATURAMENTO_UPDATE_FAILED_NOT_FOUND: 'FATURAMENTO_UPDATE_FAILED_NOT_FOUND',
FATURAMENTO_UPDATE_FAILED_DUPLICATE: 'FATURAMENTO_UPDATE_FAILED_DUPLICATE',
FATURAMENTO_DELETE_FAILED: 'FATURAMENTO_DELETE_FAILED',
FATURAMENTO_DELETE_FAILED_NOT_FOUND: 'FATURAMENTO_DELETE_FAILED_NOT_FOUND',

    // System/Other actions
    SYSTEM_ERROR: 'SYSTEM_ERROR', // Example for logging general system errors
  },
  ENTITY_TYPES: {
    USER: 'User',
    CLIENT: 'Client',
    CRM_OCCURRENCE: 'CrmOccurrence',
    GESTOR_OCCURRENCE: 'GestorOccurrence',
    FATURAMENTO: 'Faturamento',
  }
};
