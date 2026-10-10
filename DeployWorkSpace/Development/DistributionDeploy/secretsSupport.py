#-------------------------------------------------------------------------------
# secretsSupport.py
#
# Locate the shared ``secretstore`` module (Development/secretstore) for the
# deploy workflow. It is found either
#
#   * vendored at DistributionDeploy/vendor/secretstore -- buildCompiledDist.py
#     copies it there when it packages the DeployWorkspace handoff archive, so
#     the installer has it before dist_app.zip is extracted; or
#   * in the source checkout (DeployWorkSpace sits inside Development), when
#     the workflow is run straight from the repository.
#
# Loaded by file path so the Development tree is never put on sys.path of the
# deploy process (it would shadow DistributionDeploy's own modules).
#-------------------------------------------------------------------------------
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
CANDIDATES = (
    os.path.join(_HERE, "vendor", "secretstore", "__init__.py"),
    os.path.abspath(os.path.join(_HERE, "..", "..", "..", "secretstore", "__init__.py")),
)


def load():
    """Return the secretstore module, importing it on first use."""
    module = sys.modules.get("secretstore")
    if module is not None:
        return module
    for candidate in CANDIDATES:
        if os.path.isfile(candidate):
            spec = importlib.util.spec_from_file_location(
                "secretstore", candidate,
                submodule_search_locations=[os.path.dirname(candidate)])
            module = importlib.util.module_from_spec(spec)
            sys.modules["secretstore"] = module
            spec.loader.exec_module(module)
            return module
    raise ImportError(
        "secretstore not found; looked in: {}. Rebuild the DeployWorkspace archive with "
        "buildCompiledDist.py".format(", ".join(CANDIDATES)))
