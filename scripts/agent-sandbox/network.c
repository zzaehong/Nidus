// Local-only fixture; attempts one connection to the test server on loopback.
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return errno == EPERM || errno == EACCES ? 77 : 3;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons(atoi(argv[1]));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int result = connect(fd, (struct sockaddr *)&address, sizeof(address));
    int saved = errno;
    close(fd);
    if (result == 0) return 0;
    return saved == EPERM || saved == EACCES ? 77 : 4;
}
