from common.hdl import MayastorHandle
from common.command import run_cmd, run_cmd_async_at
from common.nvme import nvme_remote_connect, nvme_remote_disconnect
from common.fio import Fio
import pytest
import asyncio
import uuid as guid
import time

UUID = "0000000-0000-0000-0000-000000000001"
NEXUS_UUID = "3ae73410-6136-4430-a7b5-cbec9fe2d273"


@pytest.fixture(scope="function")
def create_temp_files(containers):
    """Create temp files for each run so we start out clean."""
    for name in containers:
        run_cmd(f"rm -rf /tmp/{name}.img", True)
    for name in containers:
        run_cmd(f"truncate -s 1G /tmp/{name}.img", True)


def check_size(prev, current, delta):
    """Validate that replica creation consumes space on the pool."""
    before = prev.pools[0].used
    after = current.pools[0].used
    assert delta == (before - after) >> 20


@pytest.fixture(scope="function")
def mayastors(docker_project, function_scoped_container_getter):
    """Fixture to get a reference to mayastor handles."""
    project = docker_project
    handles = {}
    for name in project.service_names:
        # because we use static networks .get_service() does not work
        services = function_scoped_container_getter.get(name)
        ip_v4 = services.get(
            "NetworkSettings.Networks.python_mayastor_net.IPAddress")
        handles[name] = MayastorHandle(ip_v4)
    yield handles


@pytest.fixture(scope="function")
def containers(docker_project, function_scoped_container_getter):
    """Fixture to get handles to mayastor as well as the containers."""
    project = docker_project
    containers = {}
    for name in project.service_names:
        containers[name] = function_scoped_container_getter.get(name)
    yield containers

@pytest.fixture
def create_null_devs(mayastors):
    for node in ['ms1', 'ms2']:
        ms = mayastors.get(node)

        for i in range(70):
            ms.bdev_create(f"null:///null{i}?blk_size=512&size_mb=100")

        names = ms.bdev_list()

        for n in names:
            ms.bdev_share((n.name))


async def kill_after(container, sec):
    """Kill the given container after sec seconds."""
    await asyncio.sleep(sec)
    container.kill()


@ pytest.mark.asyncio
async def test_multiple(create_null_devs,
                        containers,
                        mayastors,
                        target_vm):

    rlist_m2 = mayastors.get('ms1').bdev_list()
    rlist_m3 = mayastors.get('ms2').bdev_list()
    ms = mayastors.get('ms3')

    for i in range(70):
        uuid = guid.uuid4()
        ms.nexus_create(uuid,
                        94 * 1024 * 1024,
                        [rlist_m2.pop().share_uri,
                         rlist_m3.pop().share_uri])
        ms.nexus_publish(uuid)

    await run_cmd_async_at(target_vm,
                           f"sudo nvme connect-all  -p tcp -s 8420 -a {ms.ip_v4} -t tcp")
