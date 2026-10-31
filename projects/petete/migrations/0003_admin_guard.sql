CREATE TRIGGER IF NOT EXISTS users_keep_active_admin
BEFORE UPDATE OF role,status ON users
WHEN OLD.role='admin' AND OLD.status='active'
 AND (NEW.role!='admin' OR NEW.status!='active')
 AND (SELECT count(*) FROM users WHERE role='admin' AND status='active')<=1
BEGIN
 SELECT RAISE(ABORT,'last_active_admin');
END;
CREATE TRIGGER IF NOT EXISTS users_keep_active_admin_delete
BEFORE DELETE ON users
WHEN OLD.role='admin' AND OLD.status='active'
 AND (SELECT count(*) FROM users WHERE role='admin' AND status='active')<=1
BEGIN
 SELECT RAISE(ABORT,'last_active_admin');
END;
