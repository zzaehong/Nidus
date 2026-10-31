// Bounded, synthetic M0 workload; never accepts user commands or remote addresses.
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <time.h>
#include <errno.h>
#include <sys/socket.h>
#include <poll.h>
#include <arpa/inet.h>

static double deadline;
static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}
static void heartbeat(const char *path, int port) {
    while (now() < deadline) {
        int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
        if (fd < 0) _exit(5);
        char state = getenv("NIDUS_FIXTURE_SECRET") ? 'S' : '.';
        if (write(fd, &state, 1) != 1) _exit(6);
        close(fd);
        int net = socket(AF_INET, SOCK_STREAM, 0);
        if (net >= 0) {
            struct sockaddr_in address = {0};
            address.sin_family = AF_INET;
            address.sin_port = htons(port);
            address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            // Nonblocking local connection prevents a full listener queue extending fixture lifetime.
            fcntl(net, F_SETFL, O_NONBLOCK);
            int result = connect(net, (struct sockaddr *)&address, sizeof(address));
            if (result < 0 && errno == EINPROGRESS) {
                // Do not close during the asynchronous handshake: that would make a
                // broken positive control look like successful network isolation.
                struct pollfd pending = { .fd = net, .events = POLLOUT };
                poll(&pending, 1, 100);
            }
            close(net);
        }
        usleep(50000);
    }
    _exit(0);
}
int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const char *mode = argv[1];
    int port = atoi(argv[3]);
    if (port < 1 || port > 65535) return 2;
    if (strcmp(mode,"ordinary") && strcmp(mode,"setsid") && strcmp(mode,"double-fork") && strcmp(mode,"nested")) return 2;
    deadline = now() + 4.0;
    pid_t child = fork();
    if (child < 0) return 3;
    if (child == 0) {
        // Every fork gets a separate hard expiry; the monotonic deadline is shared by value.
        alarm(5);
        if (strcmp(mode,"ordinary") && setsid() < 0) _exit(4);
        if (!strcmp(mode,"double-fork") || !strcmp(mode,"nested")) {
            pid_t grandchild = fork();
            if (grandchild < 0) _exit(3);
            if (grandchild == 0) { alarm(5); heartbeat(argv[2], port); }
            if (!strcmp(mode,"double-fork")) _exit(0);
        }
        heartbeat(argv[2], port);
    }
    if (!strcmp(mode,"double-fork")) return 0;
    alarm(5);
    while (now() < deadline) usleep(50000);
    return 0;
}
