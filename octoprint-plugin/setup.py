import setuptools

setuptools.setup(
    name="OctoPrint-Companion",
    version="0.1.0",
    description="Companion web app for OctoPrint (same UI as the Companion touchscreen)",
    license="Apache-2.0",  # contains a build of OctoDash (Apache 2.0)
    packages=["octoprint_companion"],
    include_package_data=True,  # static/web/** via MANIFEST.in
    python_requires=">=3.9",
    entry_points={"octoprint.plugin": ["companion = octoprint_companion"]},
)
