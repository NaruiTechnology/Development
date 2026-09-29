#-------------------------------------------------------------------------------
# Name:
# Purpose:      Access privilege role decorators.
#
# Author:      liyingho
#
# Created:     06/06/2026
# Copyright:
# Licence:     <your licence>
#-------------- -----------------------------------------------------------------
import inspect
import os
from functools import wraps


ROLE_USER = 0
ROLE_SUPER_USER = 1
ROLE_DEVELOPER = 2
ROLE_ADMIN = 3
ROLE_AUDIT = 4

ACCESS_PRIVILEGE_ROLES = {
    "USER": ROLE_USER,
    "SUPER_USER": ROLE_SUPER_USER,
    "DEVELOPER": ROLE_DEVELOPER,
    "ADMIN": ROLE_ADMIN,
    "AUDIT": ROLE_AUDIT,
}

_ROLE_NAMES = dict((value, key) for key, value in ACCESS_PRIVILEGE_ROLES.items())


class AccessPrivilegeError(PermissionError):
    def __init__(self, requiredRoles, currentRole=None):
        self.requiredRoles = tuple(requiredRoles)
        self.currentRole = currentRole
        message = "access privilege denied: required {}, current {}".format(
            _roleNames(self.requiredRoles),
            _roleName(currentRole),
        )
        super(AccessPrivilegeError, self).__init__(message)


def _roleName(role):
    if role is None:
        return "UNKNOWN"
    return _ROLE_NAMES.get(role, str(role))


def _roleNames(roles):
    return ", ".join(_roleName(role) for role in roles)


def _normalizeRole(role):
    if isinstance(role, str):
        roleKey = role.strip().upper()
        if roleKey in ACCESS_PRIVILEGE_ROLES:
            return ACCESS_PRIVILEGE_ROLES[roleKey]
        return int(role)
    return int(role)


def _normalizeRoles(roles):
    if len(roles) == 1 and isinstance(roles[0], (list, tuple, set)):
        roles = tuple(roles[0])
    return tuple(_normalizeRole(role) for role in roles)


def _readRoleFromObject(obj):
    if obj is None:
        return None
    if isinstance(obj, dict):
        for key in ("role", "user_role", "current_role"):
            if key in obj:
                return _normalizeRole(obj[key])
        return None
    for attrName in ("role", "user_role", "current_role"):
        if hasattr(obj, attrName):
            return _normalizeRole(getattr(obj, attrName))
    return None


def resolveAccessPrivilegeRole(*args, **kwargs):
    for key in ("current_role", "user_role", "role"):
        if key in kwargs:
            return _normalizeRole(kwargs[key])
    for key in ("current_user", "user"):
        role = _readRoleFromObject(kwargs.get(key))
        if role is not None:
            return role
    for arg in args:
        role = _readRoleFromObject(arg)
        if role is not None:
            return role
        for attrName in ("current_user", "user"):
            if hasattr(arg, attrName):
                role = _readRoleFromObject(getattr(arg, attrName))
                if role is not None:
                    return role
    envRole = os.environ.get("IOBEAM_CURRENT_ROLE")
    if envRole is not None:
        return _normalizeRole(envRole)
    return None


def _denyAccess(requiredRoles, currentRole, exceptionFactory=None):
    if exceptionFactory is not None:
        raise exceptionFactory(requiredRoles, currentRole)
    raise AccessPrivilegeError(requiredRoles, currentRole)


def accessPrivilegeRoles(*allowedRoles, **options):
    allowedRoles = _normalizeRoles(allowedRoles)
    roleResolver = options.get("roleResolver", resolveAccessPrivilegeRole)
    exceptionFactory = options.get("exceptionFactory")

    def decorator(func):
        if inspect.iscoroutinefunction(func):
            @wraps(func)
            async def roleChecker(*args, **kwargs):
                currentRole = roleResolver(*args, **kwargs)
                if currentRole not in allowedRoles:
                    _denyAccess(allowedRoles, currentRole, exceptionFactory)
                return await func(*args, **kwargs)
        else:
            @wraps(func)
            def roleChecker(*args, **kwargs):
                currentRole = roleResolver(*args, **kwargs)
                if currentRole not in allowedRoles:
                    _denyAccess(allowedRoles, currentRole, exceptionFactory)
                return func(*args, **kwargs)
        roleChecker.allowedRoles = allowedRoles
        return roleChecker
    return decorator


def minimumAccessPrivilegeRole(minimumRole, **options):
    minimumRole = _normalizeRole(minimumRole)
    roleResolver = options.get("roleResolver", resolveAccessPrivilegeRole)
    exceptionFactory = options.get("exceptionFactory")

    def decorator(func):
        if inspect.iscoroutinefunction(func):
            @wraps(func)
            async def roleChecker(*args, **kwargs):
                currentRole = roleResolver(*args, **kwargs)
                if currentRole is None or currentRole < minimumRole:
                    _denyAccess((minimumRole,), currentRole, exceptionFactory)
                return await func(*args, **kwargs)
        else:
            @wraps(func)
            def roleChecker(*args, **kwargs):
                currentRole = roleResolver(*args, **kwargs)
                if currentRole is None or currentRole < minimumRole:
                    _denyAccess((minimumRole,), currentRole, exceptionFactory)
                return func(*args, **kwargs)
        roleChecker.minimumRole = minimumRole
        return roleChecker
    return decorator


def requireUser(func):
    return minimumAccessPrivilegeRole(ROLE_USER)(func)


def requireSuperUser(func):
    return minimumAccessPrivilegeRole(ROLE_SUPER_USER)(func)


def requireDeveloper(func):
    return minimumAccessPrivilegeRole(ROLE_DEVELOPER)(func)


def requireAdmin(func):
    return minimumAccessPrivilegeRole(ROLE_ADMIN)(func)


def requireAudit(func):
    return minimumAccessPrivilegeRole(ROLE_AUDIT)(func)


def fastApiAccessPrivilegeDependency(*allowedRoles, **options):
    allowedRoles = _normalizeRoles(allowedRoles)
    roleResolver = options.get("roleResolver", resolveAccessPrivilegeRole)

    def dependency():
        currentRole = roleResolver()
        if currentRole in allowedRoles:
            return currentRole
        try:
            from fastapi import HTTPException, status
        except ImportError:
            _denyAccess(allowedRoles, currentRole)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="access privilege denied: required {}, current {}".format(
                _roleNames(allowedRoles),
                _roleName(currentRole),
            ),
        )
    dependency.allowedRoles = allowedRoles
    return dependency
