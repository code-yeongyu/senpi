/* Non-child exit notifications for Node-run tests: no liveness polling. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#ifdef __APPLE__
#include <sys/event.h>
#else
#include <poll.h>
#include <sys/syscall.h>
#endif

int main(int argc, char **argv) {
	if (argc != 2) return 2;
	char *end;
	long pid = strtol(argv[1], &end, 10);
	if (*end || pid <= 0) return 2;
	int fd;
#ifdef __APPLE__
	fd = kqueue();
	if (fd == -1) { perror("kqueue"); return 1; }
	struct kevent event;
	EV_SET(&event, pid, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
	if (kevent(fd, &event, 1, NULL, 0, NULL) == -1) {
		int gone = errno == ESRCH;
		if (!gone) perror("register NOTE_EXIT");
		close(fd);
		return gone ? 0 : 1;
	}
#else
	fd = syscall(SYS_pidfd_open, pid, 0);
	if (fd == -1) {
		if (errno == ESRCH) return 0;
		perror("pidfd_open");
		return 1;
	}
#endif
	puts("ready");
	fflush(stdout);
	int result;
	do {
#ifdef __APPLE__
		result = kevent(fd, NULL, 0, &event, 1, NULL);
#else
		struct pollfd event = { .fd = fd, .events = POLLIN };
		result = poll(&event, 1, -1);
#endif
	} while (result == -1 && errno == EINTR);
	close(fd);
	if (result == -1) { perror("wait for process exit"); return 1; }
	return 0;
}
