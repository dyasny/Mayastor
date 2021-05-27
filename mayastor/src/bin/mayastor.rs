#[macro_use]
extern crate tracing;
use futures::future::FutureExt;
use mayastor::{
    bdev::{device_destroy, nexus_lookup, util::uring},
    core::{
        runtime,
        Command,
        MayastorCliArgs,
        MayastorEnvironment,
        Mthread,
        Reactors,
        DEAD_LIST,
    },
    grpc,
    logger,
    subsys,
};
use std::path::Path;
use structopt::StructOpt;
mayastor::CPS_INIT!();
use mayastor::{
    core::{PAUSED, PAUSING},
    persistent_store::PersistentStore,
    subsys::Registration,
};

// manual call to a gRCP method.
async fn reaper() {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        dbg!(&PAUSED);
        dbg!(&PAUSING);
        dbg!(DEAD_LIST.len());

        if let Ok(cmd) = DEAD_LIST.pop() {
            match cmd {
                Command::Retire(nexus, child) => {
                    info!("got a dead child {}", child);
                    let rx = Mthread::get_init().spawn_local(async move {
                        if let Some(nexus) = nexus_lookup(&nexus) {
                            match nexus.child_lookup(&child) {
                                Some(child) => {
                                    if let Err(err) = child.destroy().await {
                                        error!(
                                            "{}: destroying child {} failed {}",
                                            nexus, child, err
                                        );
                                    }
                                }
                                None => {}
                            }

                            nexus.clear_failfast().await.unwrap();
                            nexus.resume().await.unwrap();
                        }
                    });
                    dbg!(rx.unwrap().await);
                }
            }
        }
    }
}

fn start_tokio_runtime(args: &MayastorCliArgs) {
    let grpc_address = grpc::endpoint(args.grpc_endpoint.clone());
    let rpc_address = args.rpc_address.clone();
    let node_name = args
        .node_name
        .clone()
        .unwrap_or_else(|| "mayastor-node".into());

    let endpoint = args.mbus_endpoint.clone();
    let persistent_store_endpoint = args.persistent_store_endpoint.clone();

    Mthread::spawn_unaffinitized(move || {
        runtime::block_on(async move {
            //          runtime::spawn(reaper());
            let mut futures = Vec::new();
            if let Some(endpoint) = endpoint {
                debug!("mayastor mbus subsystem init");
                mbus_api::message_bus_init_tokio(endpoint);
                Registration::init(&node_name, &grpc_address.to_string());
                futures.push(subsys::Registration::run().boxed());
            }

            PersistentStore::init(persistent_store_endpoint).await;

            futures.push(
                grpc::MayastorGrpcServer::run(grpc_address, rpc_address)
                    .boxed(),
            );

            futures::future::try_join_all(futures)
                .await
                .expect_err("runtime exited in the abnormal state");
        });
    });
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = MayastorCliArgs::from_args();

    // setup our logger first if -L is passed, raise the log level
    // automatically. trace maps to debug at FFI level. If RUST_LOG is
    // passed, we will use it regardless.

    if !args.log_components.is_empty() {
        logger::init("TRACE");
    } else {
        logger::init("INFO");
    }

    let hugepage_path = Path::new("/sys/kernel/mm/hugepages/hugepages-2048kB");
    let nr_pages: u32 = sysfs::parse_value(&hugepage_path, "nr_hugepages")?;

    if nr_pages == 0 {
        warn!("No hugepages available, trying to allocate 512 2MB hugepages");
        sysfs::write_value(&hugepage_path, "nr_hugepages", 512)?;
    }

    let free_pages: u32 = sysfs::parse_value(&hugepage_path, "free_hugepages")?;
    let nr_pages: u32 = sysfs::parse_value(&hugepage_path, "nr_hugepages")?;
    let uring_supported = uring::kernel_support();
    let nvme_core_path = Path::new("/sys/module/nvme_core/parameters");
    let nvme_mp: String =
        match sysfs::parse_value::<String>(&nvme_core_path, "multipath") {
            Ok(s) => match s.as_str() {
                "Y" => "yes".to_string(),
                "N" => "disabled".to_string(),
                u => format!("unknown value {}", u),
            },
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    if nvme_core_path.exists() {
                        "not built".to_string()
                    } else {
                        "nvme not loaded".to_string()
                    }
                } else {
                    format!("unknown error: {}", e)
                }
            }
        };

    info!("Starting Mayastor ..");
    info!(
        "kernel io_uring support: {}",
        if uring_supported { "yes" } else { "no" }
    );
    info!("kernel nvme initiator multipath support: {}", nvme_mp);
    info!("free_pages: {} nr_pages: {}", free_pages, nr_pages);

    let ms = MayastorEnvironment::new(args.clone()).init();
    start_tokio_runtime(&args);

    Reactors::current().running();
    Reactors::current().poll_reactor();

    ms.fini();
    Ok(())
}
