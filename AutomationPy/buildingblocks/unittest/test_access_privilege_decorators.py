import asyncio
import inspect
import unittest

from ..decorators_acess_role import (
    AccessPrivilegeError,
    ROLE_ADMIN,
    ROLE_AUDIT,
    ROLE_SUPER_USER,
    ROLE_USER,
    accessPrivilegeRoles,
    minimumAccessPrivilegeRole,
    requireAdmin,
    resolveAccessPrivilegeRole,
)


class RoleContext:
    def __init__(self, role):
        self.role = role


class SessionContext:
    def __init__(self, user):
        self.current_user = user


class test_access_privilege_decorators(unittest.TestCase):
    def test_resolve_role_from_kwargs(self):
        self.assertEqual(ROLE_ADMIN, resolveAccessPrivilegeRole(current_role=ROLE_ADMIN))
        self.assertEqual(ROLE_ADMIN, resolveAccessPrivilegeRole(user={"role": "ADMIN"}))

    def test_resolve_role_from_objects(self):
        self.assertEqual(ROLE_SUPER_USER, resolveAccessPrivilegeRole(RoleContext(ROLE_SUPER_USER)))
        self.assertEqual(ROLE_AUDIT, resolveAccessPrivilegeRole(SessionContext({"role": ROLE_AUDIT})))

    def test_access_privilege_roles_allows_configured_role(self):
        @accessPrivilegeRoles(ROLE_SUPER_USER, ROLE_ADMIN, ROLE_AUDIT)
        def run_scan(*, current_role):
            return "ok"

        self.assertEqual("ok", run_scan(current_role=ROLE_ADMIN))

    def test_access_privilege_roles_denies_missing_role(self):
        @accessPrivilegeRoles(ROLE_ADMIN)
        def update_config(*, current_role):
            return "ok"

        with self.assertRaises(AccessPrivilegeError):
            update_config(current_role=ROLE_USER)

    def test_minimum_access_privilege_role(self):
        @minimumAccessPrivilegeRole(ROLE_ADMIN)
        def update_config(*, current_role):
            return "ok"

        self.assertEqual("ok", update_config(current_role=ROLE_AUDIT))
        with self.assertRaises(AccessPrivilegeError):
            update_config(current_role=ROLE_SUPER_USER)

    def test_named_role_decorator(self):
        @requireAdmin
        def update_config(*, current_role):
            return "ok"

        self.assertEqual("ok", update_config(current_role=ROLE_ADMIN))

    def test_async_function_stays_coroutine_function(self):
        @accessPrivilegeRoles(ROLE_ADMIN)
        async def update_config(*, current_role):
            return "ok"

        self.assertTrue(inspect.iscoroutinefunction(update_config))
        self.assertEqual("ok", asyncio.run(update_config(current_role=ROLE_ADMIN)))


if __name__ == "__main__":
    unittest.main()
